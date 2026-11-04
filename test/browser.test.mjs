import "./network.mjs"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { assertConsoleSession, chromeExecutable, closeKeptBrowsers as endKeptBrowsers, extractProjectId, extractAccount, extractConsoleIdentity, openBrowser, routeAll, withPage } from "../lib/browser.mjs"

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

test("Console subject matching accepts renamed emails but rejects other accounts and ambiguous page data", { timeout: 40000, ...needsBrowser }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-console-subject-"))
  const previousCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = directory
  const browser = await openBrowser({ launchArgs, profile: join(directory, "profile"), headless: true })
  t.after(async () => {
    await browser.close()
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCache
    await rm(directory, { recursive: true, force: true })
  })
  const subject = "111000000000000000001"
  const other = "111000000000000000002"
  const record = (email, id) => ({ oPEP7c: email, W3Yyqf: id, S06Grb: id, qDCSke: id })
  const json = (value) => `<script type="application/json">${JSON.stringify(value, null, 2)}</script>`
  let identity = json(record("new@example.com", subject))
  const table = '<table><thead><tr><th>Credit name</th><th>Status</th><th>Remaining value</th><th>Original value</th><th>Credit ID</th></tr></thead><tbody><tr><td>Benefit</td><td>Available</td><td>$12.00</td><td>$20.00</td><td>one</td></tr></tbody></table>'
  await routeAll(browser.page, pageFor(() => identity + table))
  const options = {
    browser, profile: join(directory, "profile"), account: "old@example.com",
    billingAccount: "AAAAAA-BBBBBB-CCCCCC",
  }
  // This is the old bug, including its cached failure. Adding the verified
  // subject must bypass that failure without erasing any production cache.
  await assert.rejects(fetchCredits(options), /signed in as new@example.com, not old@example.com/)
  const verified = { ...options, googleSubject: subject }
  const credits = await fetchCredits(verified)
  assert.equal(credits.remaining, 12)
  assert.equal(credits.googleSubject, subject)
  assert.equal(credits["consoleAccount"], "new@example.com")
  assert.deepEqual(await extractConsoleIdentity(browser.page), { account: "new@example.com", subject })
  assert.equal((await fetchCredits(verified)).cached, true)
  await assert.rejects(fetchCredits({ ...verified, googleSubject: other }), /subject mismatch/)

  // Same email is insufficient when the page positively names another subject.
  identity = json(record("old@example.com", other))
  await assert.rejects(fetchCredits({ ...verified, force: true }), /subject mismatch/)
  for (const ambiguous of [
    json({ ...record("old@example.com", subject), S06Grb: other }),
    json({ ...record("old@example.com", subject), qDCSke: undefined }),
    json(record("old@example.com", subject)) + json(record("old@example.com", other)),
  ]) {
    identity = ambiguous
    await assert.rejects(fetchCredits({ ...verified, force: true }), /conflicting account identity/)
  }
  // Account chooser arrays and nested objects never prove the active identity.
  for (const unrelated of [
    [record("new@example.com", subject)],
    { accounts: [record("new@example.com", subject)] },
  ]) {
    identity = json(unrelated)
    await assert.rejects(fetchCredits({ ...verified, force: true }), /signed in as new@example.com, not old@example.com/)
  }
  identity = json({ oPEP7c: "new@example.com" })
  await assert.rejects(fetchCredits({ ...verified, force: true }), /signed in as/)
  identity = json({ oPEP7c: "old@example.com" })
  const fallback = await fetchCredits({ ...verified, force: true })
  assert.equal(fallback.remaining, 12)
  assert.equal(fallback.googleSubject, undefined, "email fallback must not invent subject verification")
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

test("renamed Console emails use a resolved identity or explicit alias and keep cache isolation", { timeout: 30000, ...needsBrowser }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-browser-alias-"))
  const previousCache = process.env.XDG_CACHE_HOME
  let browser
  try {
    process.env.XDG_CACHE_HOME = directory
    browser = await openBrowser({ profile: join(directory, "profile"), launchArgs })
    let shown = "new@example.com"
    let requests = 0
    const selected = []
    await routeAll(browser.page, async (request) => {
      const url = new URL(request.url())
      assert.equal(url.origin, "https://console.cloud.google.com")
      if (!url.pathname.startsWith("/billing/")) return request.abort()
      selected.push(url.searchParams.get("authuser"))
      requests++
      if (url.pathname === "/billing/linkedaccount") {
        return request.fulfill({ body: '<a href="/billing/AAAAAA-BBBBBB-CCCCCC">Billing</a>' })
      }
      return request.fulfill({ body: `<!doctype html><script>var a={"oPEP7c":${JSON.stringify(shown)}}</script>
        <table><thead><tr><th>Credit name</th><th>Status</th><th>Remaining value</th><th>Original value</th><th>Credit ID</th></tr></thead>
        <tbody><tr><td>Benefit</td><td>Available</td><td>$12.00</td><td>$20.00</td><td>one</td></tr></tbody></table>` })
    })
    const options = {
      browser, profile: join(directory, "profile"), project: "example-project",
      authMode: "adc", account: "old@example.com", cloudsdkConfig: join(directory, "original-adc"),
    }
    await assert.rejects(fetchCredits(options), /signed in as new@example.com, not old@example.com/)
    const afterFailure = requests
    await assert.rejects(fetchCredits(options), /signed in as/)
    assert.equal(requests, afterFailure)
    const resolved = { ...options, consoleAccount: "new@example.com" }
    selected.length = 0
    assert.equal((await fetchCredits(resolved)).remaining, 12)
    assert.deepEqual(selected, ["new@example.com", "new@example.com"])
    const mapped = { ...options, consoleAccountAliases: { "old@example.com": "new@example.com" } }
    selected.length = 0
    const result = await fetchCredits({ ...mapped, force: true })
    assert.equal(result.remaining, 12)
    assert.equal(result.cached, false)
    assert.deepEqual(selected, ["new@example.com", "new@example.com"])
    assert.equal((await fetchCredits(mapped)).cached, true)
    assert.equal(options.account, "old@example.com")
    assert.equal(options.cloudsdkConfig, join(directory, "original-adc"))
    assert.equal((await fetchCredits({ ...mapped, cloudsdkConfig: join(directory, "other-adc") })).cached, false)
    assert.equal((await fetchCredits({
      ...mapped, account: "another-saved@example.com",
      consoleAccountAliases: { "another-saved@example.com": "new@example.com" },
    })).cached, false)

    // An alias does not authorize a fallback to an unrelated browser account.
    shown = "other@example.com"
    await assert.rejects(fetchCredits({ ...mapped, force: true }), /signed in as other@example.com, not new@example.com/)
    await assert.rejects(fetchCredits({ ...resolved, force: true }), /signed in as other@example.com, not new@example.com/)
    shown = null
    await assert.rejects(fetchCredits({ ...mapped, force: true }), /did not show which account/)
    // Another credential account cannot inherit the first account's mapping.
    shown = "new@example.com"
    await assert.rejects(fetchCredits({ ...mapped, account: "second@example.com" }), /not second@example.com/)
    // Changing the alias must not reuse either success or failure for the old one.
    shown = "renamed-again@example.com"
    const changed = await fetchCredits({ ...mapped, consoleAccountAliases: { "old@example.com": shown } })
    assert.equal(changed.cached, false)
    assert.equal(changed.remaining, 12)
    // Removing the alias restores the original check, even with a cached success.
    await assert.rejects(fetchCredits({ ...options, force: true }), /not old@example.com/)
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

// kidchen94's cases (#667), on a Console served from inside the test. Each
// read would have waited out its whole timeout on the old code and said the
// session may have expired; now it reads, or says what is wrong, at once.
async function consoleFixture(name, serve, use) {
  const directory = await mkdtemp(join(tmpdir(), `vertex-browser-${name}-`))
  const previousCache = process.env.XDG_CACHE_HOME
  let browser
  try {
    process.env.XDG_CACHE_HOME = directory
    const profile = join(directory, "profile")
    browser = await openBrowser({ profile, launchArgs })
    const paths = []
    await routeAll(browser.page, async (request) => {
      const url = new URL(request.url())
      if (url.origin !== "https://console.cloud.google.com") return request.abort()
      paths.push(url.pathname)
      // The Console names the account it rendered for under its own key.
      const shown = url.searchParams.get("authuser")
      return request.fulfill({ body: `<!doctype html>${shown ? `<script>var a={"oPEP7c":${JSON.stringify(shown)}}</script>` : ""}${serve(url)}` })
    })
    return await use({ profile, browser, paths })
  } finally {
    if (browser) await browser.close()
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCache
    await rm(directory, { recursive: true, force: true })
  }
}

const creditsTable = (rows, { html = "", head = ["Credit name", "Status", "Remaining value", "Original value", "Credit ID"] } = {}) => `<html${html}><body>
  <table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`

test("a JPY billing account is read in yen, and read as USD it names its currency at once", { timeout: 60000, ...needsBrowser }, async () => {
  await consoleFixture("jpy", () => creditsTable([["Trial", "Available", "¥8,500", "¥10,000", "one"]]), async ({ profile, browser }) => {
    const options = { profile, browser, billingAccount: "AAAAAA-BBBBBB-CCCCCC", account: "reader@example.com", scrapeTimeout: 20000 }
    const started = Date.now()
    await assert.rejects(fetchCredits(options), /in ¥ \(yen or yuan\), not USD\. If it bills in Japanese yen, set billingCurrencies to \{ "AAAAAA-BBBBBB-CCCCCC": "JPY" \}/)
    assert.ok(Date.now() - started < 15000, `the currency was named after ${Date.now() - started}ms, not at once`)
    // Naming the currency is a different read: the remembered USD failure is
    // not handed back for it.
    const yen = await fetchCredits({ ...options, billingCurrencies: { "AAAAAA-BBBBBB-CCCCCC": "JPY" } })
    assert.equal(yen.currency, "JPY")
    assert.equal(yen.remaining, 8500)
    assert.equal(usageOf(yen).balance, "¥8500 JPY")
    const cached = await fetchCredits({ ...options, billingCurrencies: { "AAAAAA-BBBBBB-CCCCCC": "JPY" } })
    assert.equal(cached.cached, true)
  })
})

test("a Console page Chrome translated is named as translated, not as an expired session", { timeout: 60000, ...needsBrowser }, async () => {
  // Chrome marks the root of a page it translated and wraps the words it
  // replaced in <font>; the amounts become words.
  const font = (text) => `<font style="vertical-align: inherit;"><font style="vertical-align: inherit;">${text}</font></font>`
  const page = creditsTable([[font("試用"), font("利用可能"), font("8.50 米ドル"), font("10.00 米ドル"), "one"]], {
    html: ' class="translated-ltr" lang="ja"', head: ["クレジット名", "ステータス", "残額", "元の値", "クレジット ID"].map(font),
  })
  await consoleFixture("translated", () => page, async ({ profile, browser }) => {
    const started = Date.now()
    await assert.rejects(fetchCredits({ profile, browser, billingAccount: "AAAAAA-BBBBBB-CCCCCC", account: "reader@example.com", scrapeTimeout: 20000 }), /translated by Chrome/)
    assert.ok(Date.now() - started < 15000, `the translation was named after ${Date.now() - started}ms, not at once`)
  })
  // The same columns without Chrome's mark (a Console in another language)
  // are named by what they say.
  await consoleFixture("foreign", () => page.replace(' class="translated-ltr"', ""), async ({ profile, browser }) => {
    await assert.rejects(fetchCredits({ profile, browser, billingAccount: "AAAAAA-BBBBBB-CCCCCC", account: "reader@example.com", scrapeTimeout: 3000 }), /columns are not the English ones this plugin reads \(it found: .*クレジット名/)
  })
})

test("billingAccounts picks a project's billing account, and an ambiguous project says which to set", { timeout: 60000, ...needsBrowser }, async () => {
  const serve = (url) => url.pathname === "/billing/linkedaccount"
    ? '<a href="/billing/AAAAAA-BBBBBB-CCCCCC">One</a><a href="/billing/DDDDDD-EEEEEE-FFFFFF">Two</a>'
    : creditsTable([["Trial", "Available", "$4.00", "$10.00", url.pathname.split("/")[2]]])
  await consoleFixture("billing", serve, async ({ profile, browser, paths }) => {
    await browser.page.goto("https://console.cloud.google.com/")
    await assert.rejects(discoverBillingAccount(browser.page, "example-project"), /Cannot tell which billing account project example-project uses \(the Console showed AAAAAA-BBBBBB-CCCCCC, DDDDDD-EEEEEE-FFFFFF\); set billingAccounts to \{ "example-project": "<billing account>" \}/)
    // Mapped, the project's credits are read without asking the Console.
    paths.length = 0
    const options = { profile, browser, project: "example-project", account: "reader@example.com", scrapeTimeout: 5000 }
    const mapped = await fetchCredits({ ...options, billingAccounts: { "example-project": "dddddd-eeeeee-ffffff" } })
    assert.equal(mapped.billingAccount, "DDDDDD-EEEEEE-FFFFFF")
    assert.equal(mapped.remaining, 4)
    const read = paths.filter((path) => path !== "/favicon.ico")
    assert.ok(read.length && read.every((path) => path === "/billing/DDDDDD-EEEEEE-FFFFFF/credits/all"), read.join(", "))
  })
})

// One user-data directory holding several Chrome profiles: without
// --profile-directory, Chrome opens the one used last.
test("a pinned profile directory is the Chrome profile every read opens", { timeout: 60000, ...needsBrowser }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-browser-profile-dir-"))
  try {
    const profile = join(directory, "profile")
    const seen = await withPage({ profile, profileDirectory: "Profile 1", launchArgs }, (page) => page.evaluate(() => "ok"))
    assert.equal(seen, "ok")
    await endKeptBrowsers()
    const { readdir } = await import("node:fs/promises")
    const entries = await readdir(profile)
    assert.ok(entries.includes("Profile 1"), `Chrome used ${entries.filter((e) => /^(Default|Profile \d+)$/.test(e)).join(", ") || "no profile"}, not Profile 1`)
    assert.ok(!entries.includes("Default"), "the unpinned Default profile was opened too")
    for (const bad of ["../escape", "a/b", "-flag", ".."]) {
      await assert.rejects(withPage({ profile, profileDirectory: bad, launchArgs }, async () => {}), /Invalid Chrome profile directory/)
    }
  } finally {
    await endKeptBrowsers()
    await rm(directory, { recursive: true, force: true })
  }
})
