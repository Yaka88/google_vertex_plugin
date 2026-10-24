import "./network.mjs"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { assertConsoleSession, chromeExecutable, closeKeptBrowsers as endKeptBrowsers, extractProjectId, extractAccount, openBrowser, routeAll, withPage } from "../lib/browser.mjs"

// A kept browser is meant to outlive one read; a test that opens several must
// not leave them running behind it.
process.env.VERTEX_CHROME_IDLE = "0"
import { discoverBillingAccount, fetchCredits, usageOf } from "../lib/credits.mjs"

// Chrome's services run outside routeAll. Deny external name resolution at
// launch, as one argv value (no shell quotes), for every test browser.
const launchArgs = [
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
  // Any request not served by routeAll is sent to a closed loopback port.
  // Chrome may still perform its own numeric IPv6 reachability probe.
  "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>",
]

// These tests drive the machine's own Chrome, which the plugin starts and
// speaks to over its pipe transport. A machine with no Chrome can still load
// the plugin and its hooks; it just cannot open a browser, and says so here
// rather than failing as a broken test.
const chrome = await chromeExecutable().then(() => true, () => false)
const needsBrowser = { skip: chrome ? false : "Chrome is not installed; set VERTEX_CHROME_PATH to run the browser tests" }

// A stand-in for Google, served from inside the test: every request the page
// makes is answered here, so nothing leaves the machine.
function pageFor(answers) {
  return async (request) => {
    const url = new URL(request.url())
    if (url.hostname === "console.cloud.google.com") {
      const html = answers(url) ?? "<h1>Google Cloud Console</h1>"
      return request.fulfill({ body: `<!doctype html>${html}` })
    }
    if (url.hostname === "accounts.google.com") {
      const html = answers(url) ?? '<h1>Sign in with your Google Account</h1><input name="identifier">'
      return request.fulfill({ body: `<!doctype html>${html}` })
    }
    return request.abort()
  }
}

// The timeout is stated because this test waits out a real passive sign-in
// redirect: two seconds beyond the default a runner like Bun gives a test.
test("Console session waits for passive sign-in, rejects persistent forms, and handles a closed page", { timeout: 40000, ...needsBrowser }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-browser-session-"))
  let browser
  try {
    browser = await openBrowser({ launchArgs, profile: join(directory, "profile") })
    const hosts = new Set()
    await routeAll(browser.page, pageFor((url) => {
      hosts.add(url.hostname)
      if (url.hostname === "accounts.google.com") {
        if (url.searchParams.has("passive")) return '<h1>Sign in with your Google Account</h1><input name="identifier"><script>setTimeout(()=>location.href="https://console.cloud.google.com/?project=example-project",9000)</script>'
        if (url.searchParams.has("project")) return '<h1>Sign in with your Google Account</h1><script>setTimeout(()=>location.href="https://console.cloud.google.com/?project=example-project",100)</script>'
        if (url.searchParams.has("billing")) return '<h1>Sign in with your Google Account</h1><script>setTimeout(()=>location.href="https://console.cloud.google.com/billing/linkedaccount?returned=true",100)</script>'
        return '<h1>Sign in with your Google Account</h1><input type="password">'
      }
      if (url.pathname === "/billing/linkedaccount") {
        return url.searchParams.has("returned")
          ? '<script>setTimeout(()=>document.body.innerHTML+=\'<a href="/billing/AAAAAA-BBBBBB-CCCCCC">Billing account</a>\',100)</script>'
          : '<script>location.href="https://accounts.google.com/v3/signin/identifier?billing=true"</script>'
      }
      if (url.pathname === "/signin") return '<h1>Sign in with your Google Account</h1><input type="password">'
      if (url.pathname === "/denied") return "<h1>You need additional access</h1>"
      return undefined
    }))
    await browser.page.goto("https://accounts.google.com/v3/signin/identifier?passive=true")
    const start = Date.now()
    await assertConsoleSession(browser.page)
    assert.ok(Date.now() - start >= 8000)
    assert.equal(new URL(await browser.page.url()).hostname, "console.cloud.google.com")
    await browser.page.goto("https://accounts.google.com/v3/signin/identifier?project=true")
    assert.equal(await extractProjectId(browser.page), "example-project")
    assert.equal(await discoverBillingAccount(browser.page, "example-project"), "AAAAAA-BBBBBB-CCCCCC")
    for (const url of ["https://accounts.google.com/v3/signin/identifier", "https://console.cloud.google.com/signin", "https://accounts.google.com/v3/signin/identifier?continue=https://console.cloud.google.com"]) {
      await browser.page.goto(url)
      await assert.rejects(assertConsoleSession(browser.page, { timeout: 150 }), /Google session expired/)
    }
    await browser.page.goto("https://console.cloud.google.com/denied")
    await assert.rejects(assertConsoleSession(browser.page), /permission denied/)
    await assert.rejects(assertConsoleSession(browser.page, { timeout: 0 }), /positive number/)
    // Nothing reached a host this test did not answer.
    assert.deepEqual([...hosts].sort(), ["accounts.google.com", "console.cloud.google.com"])
    await browser.page.goto("https://accounts.google.com/v3/signin/identifier")
    const closed = assert.rejects(assertConsoleSession(browser.page), /page closed/)
    await browser.page.close()
    await closed
  } finally {
    if (browser) await browser.close()
    await rm(directory, { recursive: true, force: true })
  }
})

// The Console names the signed-in account under an obfuscated key. A page that
// has an address but not that key has no answer: another address on it could be
// a project member, a billing contact, or a notification.
test("the signed-in account is only read from the Console's own keyed field", { timeout: 40000, ...needsBrowser }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-browser-account-"))
  let browser
  try {
    browser = await openBrowser({ launchArgs, profile: join(directory, "profile"), headless: true })
    await routeAll(browser.page, async (request) => request.fulfill({ body: '<!doctype html><p>Contact billing@example.com or owner@example.com</p>' }))
    await browser.page.goto("https://console.cloud.google.com/")
    assert.equal(await extractAccount(browser.page, { timeout: 1000 }), undefined)
    // The keyed field arrives with the Console's own payload, a moment after
    // the document it is in.
    await routeAll(browser.page, async (request) => request.fulfill({
      body: '<!doctype html><p>contact billing@example.com</p><script>setTimeout(()=>{const s=document.createElement("script");s.textContent=\'var a={"oPEP7c":"me@example.com"}\';document.head.appendChild(s)},500)</script>',
    }))
    await browser.page.goto("https://console.cloud.google.com/")
    assert.equal(await extractAccount(browser.page, { timeout: 5000 }), "me@example.com")
  } finally {
    if (browser) await browser.close()
    await rm(directory, { recursive: true, force: true })
  }
})

// Two accounts are two tabs of one Chrome, not two Chromes: the second read
// must land in the browser the first one left open.
test("a second read on one profile is a tab of the browser the first left open", { timeout: 60000, ...needsBrowser }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-browser-reuse-"))
  const previousIdle = process.env.VERTEX_CHROME_IDLE
  try {
    process.env.VERTEX_CHROME_IDLE = "60000"
    const profile = join(directory, "profile")
    const seen = []
    const read = (label) => withPage({ profile, launchArgs }, async (page) => {
      seen.push({ label, connection: page.connection, pid: page.connection.child.pid, targetId: page.targetId })
      await routeAll(page, pageFor(() => "<h1>Google Cloud Console</h1>"))
      await page.goto("https://console.cloud.google.com/")
      return label
    })
    assert.equal(await read("first"), "first")
    assert.equal(await read("second"), "second")
    assert.equal(seen.length, 2)
    // Same Chrome process, so the second read paid for a tab and nothing else.
    assert.equal(seen[0].pid, seen[1].pid)
    assert.equal(seen[0].connection, seen[1].connection)
    assert.equal(seen[0].connection.closed, false)
    // Each read got its own target, and the first one's is gone: what was kept
    // is the browser, never the tab a read used.
    assert.notEqual(seen[0].targetId, seen[1].targetId)
    let open = []
    for (let i = 0; i < 50; i++) {
      open = (await seen[0].connection.send("Target.getTargets")).targetInfos
      if (!open.some((target) => target.targetId === seen[0].targetId)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(!open.some((target) => target.targetId === seen[0].targetId), "the first read's tab is still open")
  } finally {
    if (previousIdle === undefined) delete process.env.VERTEX_CHROME_IDLE
    else process.env.VERTEX_CHROME_IDLE = previousIdle
    await endKeptBrowsers()
    await rm(directory, { recursive: true, force: true })
  }
})

test("Chrome credits scrape handles pagination, keeps cache isolated, and force refresh bypasses it", { timeout: 60000, ...needsBrowser }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-browser-credits-"))
  const previousCache = process.env.XDG_CACHE_HOME
  let browser
  try {
    process.env.XDG_CACHE_HOME = directory
    const profile = join(directory, "profile")
    browser = await openBrowser({ profile, launchArgs })
    let requests = 0
    await routeAll(browser.page, async (request) => {
      const url = new URL(request.url())
      assert.equal(url.origin, "https://console.cloud.google.com")
      assert.match(url.pathname, /^\/billing\//)
      assert.ok(url.searchParams.get("authuser").endsWith("@example.com"))
      requests++
      // The Console names the account it rendered for under its own obfuscated
      // key, which is what a credits read is checked against.
      const shown = url.searchParams.get("authuser")
      return request.fulfill({ body: `<!doctype html><script>var a={"oPEP7c":${JSON.stringify(shown)}}</script><table><thead><tr>
        <th>Credit name</th><th>Status</th><th>Remaining value</th><th>Original value</th><th>Credit ID</th>
        </tr></thead><tbody><tr><td>Benefit one</td><td>Available</td><td>$10.00</td><td>$10.00</td><td>one</td></tr></tbody></table>
        <button aria-label="Next page" onclick="document.querySelector('tbody').innerHTML='<tr><td>Benefit two</td><td>Available</td><td>$2.07</td><td>$10.00</td><td>two</td></tr>';this.disabled=true">Next</button>` })
    })
    const options = { profile, browser, billingAccount: "AAAAAA-BBBBBB-CCCCCC", account: "first@example.com" }
    const first = await fetchCredits(options)
    assert.equal(first.remaining, 12.07)
    assert.equal(first.original, 20)
    const count = requests
    const second = await fetchCredits(options)
    assert.equal(second.cached, true)
    assert.equal(requests, count)
    const forced = await fetchCredits({ ...options, force: true })
    assert.equal(forced.cached, false)
    assert.ok(requests > count)
    assert.equal(usageOf(forced).windows[0].amount, 7.93)
    const different = await fetchCredits({ ...options, billingAccount: "AAAAAA-BBBBBB-DDDDDD" })
    assert.equal(different.cached, false)
    const otherAccount = await fetchCredits({ ...options, account: "second@example.com" })
    assert.equal(otherAccount.cached, false)
  } finally {
    if (browser) await browser.close()
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCache
    await rm(directory, { recursive: true, force: true })
  }
})

// A failed read is remembered, so a project that cannot read its credits does
// not open a browser on every usage poll: the cache is what stands in for a
// switch here, since asking again would cost a browser for the same answer.
test("a failed credit read is cached instead of opening a browser each poll", { timeout: 30000, ...needsBrowser }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-browser-failure-"))
  const previousCache = process.env.XDG_CACHE_HOME
  let browser
  try {
    process.env.XDG_CACHE_HOME = directory
    const profile = join(directory, "profile")
    let requests = 0
    browser = await openBrowser({ profile, launchArgs })
    await routeAll(browser.page, async (request) => {
      requests++
      return request.fulfill({ body: "<!doctype html><h1>No credits table here</h1>" })
    })
    // The scrape gives up on a Console page that has no table rather than
    // waiting out the page's whole patience.
    const options = { profile, browser, billingAccount: "AAAAAA-BBBBBB-CCCCCC", scrapeTimeout: 3000 }
    await assert.rejects(fetchCredits(options), /Credits table was not found/)
    const afterFirst = requests
    assert.ok(afterFirst > 0)
    // The second poll answers from the remembered failure without a browser.
    await assert.rejects(fetchCredits(options), /Credits table was not found/)
    assert.equal(requests, afterFirst)
    // Asking again on purpose does try again.
    await assert.rejects(fetchCredits({ ...options, force: true }), /Credits table was not found/)
    assert.ok(requests > afterFirst)
  } finally {
    if (browser) await browser.close()
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCache
    await rm(directory, { recursive: true, force: true })
  }
})
