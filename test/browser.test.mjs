import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { assertConsoleSession, extractProjectId, openBrowser } from "../lib/browser.mjs"
import { discoverBillingAccount, fetchCredits, usageOf } from "../lib/credits.mjs"

// These two tests drive a real Chrome, so they need the plugin's one runtime
// dependency installed. A checkout that never ran `bun install` can still load
// the plugin and its hooks; it just cannot open a browser, and says so here
// rather than failing as a broken test.
const installed = await import("playwright-core").then(() => true, () => false)
const needsBrowser = { skip: installed ? false : "playwright-core is not installed (run bun install)" }

// The timeout is stated because this test waits out a real passive sign-in
// redirect: two seconds beyond the default a runner like Bun gives a test.
test("Console session waits for passive sign-in, rejects persistent forms, and handles a closed page", { timeout: 30000, ...needsBrowser }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-browser-session-"))
  let browser
  try {
    browser = await openBrowser({ profile: join(directory, "profile") })
    await browser.context.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      assert.ok(["accounts.google.com", "console.cloud.google.com"].includes(url.hostname))
      let body = "<h1>Google Cloud Console</h1>"
      if (url.hostname === "accounts.google.com") {
        body = '<h1>Sign in with your Google Account</h1><input name="identifier">'
        if (url.searchParams.has("passive")) body += '<script>setTimeout(()=>location.href="https://console.cloud.google.com/?project=example-project",9000)</script>'
        if (url.searchParams.has("project")) body += '<script>setTimeout(()=>location.href="https://console.cloud.google.com/?project=example-project",100)</script>'
        if (url.searchParams.has("billing")) body += '<script>setTimeout(()=>location.href="https://console.cloud.google.com/billing/linkedaccount?returned=true",100)</script>'
      } else if (url.pathname === "/billing/linkedaccount") {
        body += url.searchParams.has("returned")
          ? '<script>setTimeout(()=>document.body.innerHTML+=\'<a href="/billing/AAAAAA-BBBBBB-CCCCCC">Billing account</a>\',100)</script>'
          : '<script>location.href="https://accounts.google.com/v3/signin/identifier?billing=true"</script>'
      } else if (url.pathname === "/signin") {
        body = '<h1>Sign in with your Google Account</h1><input type="password">'
      } else if (url.pathname === "/denied") {
        body = "<h1>You need additional access</h1>"
      }
      await route.fulfill({ contentType: "text/html", body: `<!doctype html>${body}` })
    })
    await browser.page.goto("https://accounts.google.com/v3/signin/identifier?passive=true")
    const start = Date.now()
    await assertConsoleSession(browser.page)
    assert.ok(Date.now() - start >= 8000)
    assert.equal(new URL(browser.page.url()).hostname, "console.cloud.google.com")
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
    await browser.page.goto("https://accounts.google.com/v3/signin/identifier")
    const closed = assert.rejects(assertConsoleSession(browser.page), /page closed/)
    await browser.page.close()
    await closed
  } finally {
    if (browser) await browser.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("Chrome credits scrape handles pagination, keeps cache isolated, and force refresh bypasses it", needsBrowser, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-browser-credits-"))
  const previousCache = process.env.XDG_CACHE_HOME
  let browser
  try {
    process.env.XDG_CACHE_HOME = directory
    const profile = join(directory, "profile")
    browser = await openBrowser({ profile })
    let requests = 0
    await browser.context.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      assert.equal(url.origin, "https://console.cloud.google.com")
      assert.match(url.pathname, /^\/billing\//)
      assert.ok(url.searchParams.get("authuser").endsWith("@example.com"))
      requests++
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><table><thead><tr>
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
