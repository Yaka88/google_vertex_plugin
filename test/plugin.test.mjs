import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../index.mjs"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { EventEmitter } from "node:events"
import { accountOf, adcDirectoryFor, adcFile, adcSlug, authorizeAdc, effectiveAuthMode, resolveAccount, resolveAdcDirectory, resolveIdentity, resolveProject, runGcloud, startLogin, tokenProvider } from "../lib/credentials.mjs"
import { fakeGcloud } from "./gcloud.mjs"
import { parseCreditTables, usageOf } from "../lib/credits.mjs"
import { availableModels, toProviderModels } from "../lib/models.mjs"
import { assertConsoleSession } from "../lib/browser.mjs"
import { main } from "../lib/fetch_credits.mjs"

const headers = ["Credit name", "Status", "Percent remaining", "Remaining value", "Original value", "Type", "Credit ID", "Usage scope", "Start date", "End date"]
const row = (id, remaining, original = "$10.00", status = "Available", start = "July 15, 2026", end = "July 1, 2027") => ["Example benefit", status, "100%", remaining, original, "One-time", id, "All Google Cloud services", start, end]
const now = Date.parse("2026-10-18T12:00:00Z")

test("credits sum active rows, deduplicate IDs, reject future/expired rows, and count exhausted grants", () => {
  const tables = [{ headers, rows: [row("a", "$10.00"), row("b", "$2.07"), row("b", "$2.07"), row("expired", "$262.09", "$300.00", "Expired"), row("future", "$10.00", "$10.00", "Available", "January 1, 2027"), row("used", "$0.00", "$10.00", "Exhausted")] }]
  const result = parseCreditTables(tables, { now })
  assert.equal(result.remaining, 12.07)
  assert.equal(result.original, 30)
  assert.equal(result.used, 17.93)
  assert.equal(result.runsOutAt, "2027-07-01T00:00:00.000Z")
  const usage = usageOf(result)
  assert.equal(usage.windows[0].amount, 17.93)
  assert.equal(usage.windows[0].limit, 30)
  assert.match(usage.windows[0].display, /\$12\.07 remaining/)
})

test("Used credits count as fully spent and never increase eligible balance", () => {
  for (const status of ["Used", "used", "Exhausted", "Used up"]) {
    const result = parseCreditTables([{ headers, rows: [row("active", "$2.07"), row("spent", "$1.00", "$10.00", status)] }], { now })
    assert.equal(result.remaining, 2.07)
    assert.equal(result.original, 20)
    assert.equal(result.used, 17.93)
    assert.equal(result.credits.find((credit) => credit.id === "spent").remaining, 0)
  }
  const result = parseCreditTables([{ headers, rows: [row("used", "$0.00", "$10.00", "Used")] }], { now })
  assert.equal(result.remaining, 0)
  assert.equal(result.usedPercent, 100)
})

test("credits fail closed on missing layout, unknown statuses, unsupported currencies and invalid amounts", () => {
  assert.throws(() => parseCreditTables([]), /not found/)
  assert.throws(() => parseCreditTables([{ headers, rows: [row("a", "$1.00", "$10.00", "Mystery")] }]), /Unknown/)
  assert.throws(() => parseCreditTables([{ headers, rows: [row("a", "€1.00")] }]), /currency/)
  assert.throws(() => parseCreditTables([{ headers, rows: [row("a", "$11.00")] }]), /Invalid/)
  assert.equal(parseCreditTables([{ headers, rows: [row("a", "$10.00", "$10.00", "Expired")] }], { now }).remaining, 0)
})

test("session checking recovers from navigation context loss within the same deadline", async () => {
  let attempts = 0
  let disposed = false
  const timeouts = []
  await assertConsoleSession({
    isClosed: () => false,
    waitForFunction: async (_, argument, options) => {
      timeouts.push(options.timeout)
      if (++attempts === 1) throw new Error("Execution context was destroyed, most likely because of a navigation")
      return { jsonValue: async () => ({ text: "Google Cloud Console" }), dispose: async () => { disposed = true } }
    },
  }, { timeout: 1000 })
  assert.equal(attempts, 2)
  assert.equal(disposed, true)
  assert.ok(timeouts[1] <= timeouts[0])
  await assert.rejects(assertConsoleSession({ isClosed: () => false, waitForFunction: async () => { throw new Error("Unexpected protocol failure") } }), /Unexpected protocol failure/)
})

test("gcloud resolves explicit and configured identities and rejects missing or malformed configuration", async () => {
  const fixture = await fakeGcloud()
  try {
    assert.deepEqual(await resolveIdentity(), { project: "example-project", account: "user@example.com", source: "gcloud", authMode: "gcloud" })
    assert.equal(await resolveProject({ project: "custom-project" }, () => assert.fail("Explicit project should not query gcloud")), "custom-project")
    process.env.GOOGLE_VERTEX_PROJECT = "environment-project"
    assert.equal(await resolveProject(), "environment-project")
    delete process.env.GOOGLE_VERTEX_PROJECT
    process.env.GOOGLE_CLOUD_PROJECT = "cloud-project"
    assert.equal(await resolveProject(), "cloud-project")
    delete process.env.GOOGLE_CLOUD_PROJECT
    await fixture.set({ project: "(unset)", account: "(unset)" })
    await assert.rejects(resolveProject(), /No Google Cloud project/)
    // The project the signed-in Chrome is on beats anything gcloud remembers,
    // and an explicit project still beats both.
    assert.equal(await resolveProject({ chromeProject: "chrome-project" }), "chrome-project")
    assert.equal(await resolveProject({ project: "explicit-project", chromeProject: "chrome-project" }), "explicit-project")
    await assert.rejects(resolveAccount(), /No Google Cloud account/)
    await assert.rejects(resolveProject({ project: "bad/project" }), /project ID/)
    await assert.rejects(resolveAccount({ account: "--bad@example.com" }), /account email/)
    await fixture.set({ fail: true })
    await assert.rejects(runGcloud(["auth", "print-access-token"]), (error) => !error.message.includes("SECRET") && /gcloud auth login/.test(error.message))
  } finally { await fixture.close() }
})

test("gcloud tokens merge concurrent requests and delegate expiry checks and renewal to gcloud", async () => {
  const fixture = await fakeGcloud()
  try {
    const getToken = tokenProvider({ account: "pinned@example.com" })
    assert.deepEqual(await Promise.all([getToken(), getToken(), getToken()]), ["fixture-token", "fixture-token", "fixture-token"])
    let calls = (await fixture.calls()).filter((args) => args[1] === "print-access-token")
    assert.equal(calls.length, 1)
    assert.ok(calls[0].includes("--account=pinned@example.com"))
    await fixture.set({ token: "renewed-token" })
    assert.equal(await getToken(), "renewed-token")
    await fixture.set({ fail: true })
    await assert.rejects(getToken(), /gcloud could not/)
    await fixture.set({ token: "recovered-token" })
    assert.equal(await getToken(), "recovered-token")
    for (const token of ["", "bad token"]) {
      await fixture.set({ token })
      await assert.rejects(getToken(), /empty or invalid/)
    }
  } finally { await fixture.close() }
})

test("CLI verifies gcloud without exposing tokens and rejects all removed key flags", async () => {
  for (const flag of ["--source-key", "--key-path", "--service-account"]) {
    await assert.rejects(main(["credentials", flag, "/unused.json"]), /Unknown option/)
  }
  const fixture = await fakeGcloud()
  const originalLog = console.log
  let output
  try {
    console.log = (value) => { output = JSON.parse(value) }
    await main(["credentials", "--account", "selected@example.com"])
    assert.deepEqual(output, { project: "example-project", account: "selected@example.com", source: "gcloud", authMode: "gcloud", cloudsdkConfig: process.env.CLOUDSDK_CONFIG, inferenceAuth: "token-verified" })
    assert.ok(!JSON.stringify(output).includes("fixture-token"))
  } finally { console.log = originalLog; await fixture.close() }
})

test("ADC names its sign-in from the token, so the row shows the account and not \"Signed in\"", async () => {
  const asked = []
  const request = async (url, init) => {
    asked.push([url, init.headers.authorization])
    return { ok: true, json: async () => ({ email: "adc@example.com", email_verified: true }) }
  }
  assert.equal(await accountOf("fixture-token", request), "adc@example.com")
  assert.deepEqual(asked, [["https://openidconnect.googleapis.com/v1/userinfo", "Bearer fixture-token"]])
  // A refused or broken lookup leaves the sign-in working and unnamed.
  assert.equal(await accountOf("t", async () => ({ ok: false })), undefined)
  assert.equal(await accountOf("t", async () => { throw new Error("offline") }), undefined)
  assert.equal(await accountOf("t", async () => ({ ok: true, json: async () => ({ email: "--not-an-email" }) })), undefined)
})

test("ADC setup opens gcloud's own consent URL in the existing Chrome, so one sign-in makes both ADC and cookies", async () => {
  const opened = []
  const page = { goto: async (url) => { opened.push(url) } }
  // gcloud writes its URL across several stderr chunks, as the real one does.
  const sibling = (pieces, code) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setTimeout(() => { for (const piece of pieces) child.stderr.emit("data", piece); setTimeout(() => child.emit("exit", code), 10) }, 5)
    return child
  }
  const missing = () => {
    const child = sibling([], 0)
    setTimeout(() => child.emit("error", Object.assign(new Error("no gcloud"), { code: "ENOENT" })), 5)
    return child
  }
  const calls = []
  const run = (command, args, options) => {
    calls.push({ command, args, env: options.env })
    return sibling([
      "Your browser has been opened to visit:\n\n    https://accounts.google.com/o/oauth2/auth?response_type=code&cli",
      "ent_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F&state=y\n\n",
    ], 0)
  }
  const fixture = await fakeGcloud()
  try {
    await fixture.clearAdc()
    await authorizeAdc(page, { project: "example-project" }, run)
    await new Promise((done) => setTimeout(done, 50))
    // One URL opened, from gcloud's own flow; BROWSER is neutralised so the
    // plugin's Chrome, and not a second window gcloud starts, shows it.
    assert.equal(opened.length, 1)
    assert.match(opened[0], /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?response_type=code&client_id=x/)
    assert.equal(calls[0].command, "gcloud")
    assert.deepEqual(calls[0].args, ["auth", "application-default", "login", "--project=example-project", "--billing-project=example-project"])
    assert.equal(calls[0].env.BROWSER, "true")
    // A chunk boundary is not the end of the URL: nothing is opened until the
    // whole address has arrived.
    opened.length = 0
    const split = (pieces, code) => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}
      setTimeout(() => { for (const piece of pieces) child.stderr.emit("data", piece) }, 5)
      setTimeout(() => child.emit("exit", code), 40)
      return child
    }
    const slow = (pieces) => split([...pieces, "\n"], 0)
    await authorizeAdc(page, {}, () => slow(["https://accounts.google.com/o/oauth2/auth?response_type=code", "&client_id=x&state=y"]))
    assert.equal(opened.length, 1)
    // The newline gcloud ends the URL with is not part of the address.
    assert.match(opened[0].trimEnd(), /client_id=x&state=y$/)
    // ADC written before gcloud's own quota-project probe failed: the sign-in
    // worked, so the exit code is not the answer.
    await fixture.clearAdc()
    const writesThenFails = () => {
      const child = split([], 1)
      setTimeout(() => { void fixture.setAdc({ quota_project_id: "adc-project" }) }, 5)
      return child
    }
    await authorizeAdc(page, {}, writesThenFails)
    // Nothing written: that is a real failure.
    await fixture.clearAdc()
    await assert.rejects(authorizeAdc(page, {}, () => split([], 1)), /gcloud could not set up ADC/)
    await assert.rejects(authorizeAdc(page, {}, missing), /gcloud CLI was not found/)
  } finally { await fixture.close() }
})

test("ADC uses only its own token command, never assumes the active gcloud account, and adds ADC only when there is none", async () => {
  const fixture = await fakeGcloud()
  try {
    const identity = await resolveIdentity({ authMode: "adc" })
    assert.deepEqual(identity, { project: "example-project", source: "gcloud", authMode: "adc" })
    assert.equal(await tokenProvider(identity)(), "fixture-token")
    const calls = await fixture.calls()
    assert.ok(calls.some((args) => args.slice(0, 3).join(" ") === "auth application-default print-access-token"))
    // Merely reading an ADC identity never tries to create one.
    assert.ok(!calls.some((args) => args.includes("login")))
    await fixture.set({ fail: true })
    await assert.rejects(tokenProvider(identity)(), /gcloud auth application-default login/)
    // An explicit gcloud mode is the user's own sign-in to make: ADC is used
    // as it stands and never created by the plugin.
    await fixture.setAdc({ quota_project_id: "adc-project" })
    await fixture.set({ token: "fixture-token" })
    const login = await startLogin({ project: "example-project", account: "user@example.com", authMode: "gcloud" }, async () => ({
      page: { goto: async () => {}, isClosed: () => false, waitForFunction: async () => { throw new Error("no Console in this test") } },
      close: async () => {},
    }))
    const result = await login.result
    assert.equal(result.creditsSession, "unavailable")
    assert.match(result.warning, /no Console/)
    assert.ok(!(await fixture.calls()).some((args) => args.includes("login")))
    await assert.rejects(tokenProvider({ authMode: "unknown" })(), /must be auto, gcloud or adc/)
  } finally { await fixture.close() }
})

test("auto mode prefers ADC like official Vertex clients, takes its quota project, and falls back to gcloud", async () => {
  const fixture = await fakeGcloud()
  try {
    // No ADC file: the gcloud user login remains the identity.
    assert.equal(await effectiveAuthMode(), "gcloud")
    assert.deepEqual(await resolveIdentity(), { project: "example-project", account: "user@example.com", source: "gcloud", authMode: "gcloud" })
    // ADC exists: it wins, and its recorded quota project beats gcloud's project.
    await fixture.setAdc({ quota_project_id: "adc-project" })
    assert.equal(await effectiveAuthMode(), "adc")
    assert.deepEqual(await resolveIdentity(), { project: "adc-project", source: "gcloud", authMode: "adc" })
    assert.equal(await tokenProvider({})() , "fixture-token")
    assert.ok((await fixture.calls()).some((args) => args.slice(0, 3).join(" ") === "auth application-default print-access-token"))
    // An explicit mode still overrides detection in both directions.
    assert.equal(await effectiveAuthMode({ authMode: "gcloud" }), "gcloud")
    await fixture.clearAdc()
    assert.equal(await effectiveAuthMode({ authMode: "adc" }), "adc")
    // GOOGLE_APPLICATION_CREDENTIALS points ADC at an explicit file.
    const explicit = join(fixture.directory, "service-account.json")
    await writeFile(explicit, JSON.stringify({ type: "service_account", project_id: "file-project" }))
    process.env.GOOGLE_APPLICATION_CREDENTIALS = explicit
    assert.equal(await effectiveAuthMode(), "adc")
    assert.equal(await adcFile(), explicit)
  } finally { await fixture.close() }
})

test("Chrome login reuses terminal credentials, closes its window afterwards, and keeps inference when Console fails", async () => {
  const fixture = await fakeGcloud()
  try {
    await fixture.setAdc({ quota_project_id: "adc-project" })
    for (const denied of [false, true]) {
      let closed = 0
      let visited
      // The first Console visit reports permission; later ones are the real
      // check. Google Account names the signed-in profile.
      const answers = denied ? ["Permission denied", "Permission denied"] : ["Google Cloud Console", "Google Cloud Console"]
      const browser = {
        page: {
          goto: async (url) => { visited = new URL(url) },
          isClosed: () => false,
          waitForFunction: async (fn) => {
            // The Console page is asked two things: whether it is signed in
            // (projectInConsole) and who it belongs to (accountInPage). Both
            // answer from the one page this test loads.
            const source = String(fn)
            if (source.includes("gserviceaccount")) return { jsonValue: async () => "signed-in@example.com", dispose: async () => {} }
            if (source.includes("last_project_id")) return { jsonValue: async () => "adc-project", dispose: async () => {} }
            return { jsonValue: async () => ({ text: answers.shift() ?? "Google Cloud Console" }), dispose: async () => {} }
          },
        },
        close: async () => { closed++ },
      }
      // A sign-in that already used the default ADC keeps using it: that is
      // the single-account machine this profile has always served.
      const login = await startLogin({ cloudsdkConfig: process.env.CLOUDSDK_CONFIG }, async (options) => {
        assert.equal(options.headless, false)
        return browser
      })
      const result = await login.result
      assert.equal(result.project, "adc-project")
      // The sign-in's window is closed once it is done: the profile keeps its
      // cookies on disk, and no Chrome is left running behind the user.
      await login.close()
      assert.equal(closed, 1)
      assert.equal(result.creditsSession, denied ? "unavailable" : "ready")
      if (denied) assert.match(result.warning, /permission denied/i)
      // The page that named the project and account is the one that stays:
      // nothing navigates again just to re-ask what it already answered.
      if (!denied) {
        assert.equal(visited.searchParams.get("project"), null)
        assert.equal(result.account, "signed-in@example.com")
      }
    }
    assert.ok(!(await fixture.calls()).some((args) => args.includes("login")))
  } finally { await fixture.close() }
})

test("a second Google account gets its own ADC directory, and an unknown one never borrows the first account's", async () => {
  const fixture = await fakeGcloud()
  try {
    // No ADC anywhere: the first sign-in takes gcloud's default directory.
    assert.deepEqual(await resolveAdcDirectory({ account: "first@example.com" }), { directory: adcDirectoryFor("first@example.com"), exists: false })
    // An ADC whose token answers for this account is its own, whichever
    // directory holds it, so a working single-account machine is left alone.
    await fixture.set({ token: "fixture-token" })
    const userinfo = async () => ({ ok: true, json: async () => ({ email: "first@example.com" }) })
    const original = globalThis.fetch
    globalThis.fetch = userinfo
    try {
      await fixture.setAdc()
      assert.deepEqual(await resolveAdcDirectory({ account: "first@example.com" }), { directory: undefined, exists: true })
      // A different account must not inherit that ADC: it gets a directory of
      // its own and is made to sign in there.
      assert.deepEqual(await resolveAdcDirectory({ account: "second@example.com" }), { directory: adcDirectoryFor("second@example.com"), exists: false })
    } finally { globalThis.fetch = original }
    // An account that named a directory is read only from there, even while
    // GOOGLE_APPLICATION_CREDENTIALS points somewhere else.
    const own = join(fixture.directory, "own-sdk")
    await mkdir(own, { recursive: true })
    await writeFile(join(own, "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "secret", refresh_token: "refresh" }))
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(fixture.directory, "elsewhere.json")
    assert.equal(await adcFile({ cloudsdkConfig: own }), join(own, "application_default_credentials.json"))
    assert.deepEqual(await resolveAdcDirectory({ cloudsdkConfig: "~/own-sdk" }), { directory: join(homedir(), "own-sdk"), exists: false })
  } finally { await fixture.close() }
})

// A page for a Chrome profile that holds several Google accounts. Google's
// add-account page brings the browser back to the Console as the account that
// was just signed in there, which is what `added` stands in for.
function profileOf(accounts, project = "adc-project", added = accounts.at(-1)) {
  const visited = []
  const consolePage = () => new URL("https://console.cloud.google.com/?hl=en")
  const page = {
    goto: async (url) => { visited.push(new URL(url)) },
    url: () => String(visited.at(-1) ?? ""),
    isClosed: () => false,
    waitForFunction: async (fn) => {
      const source = String(fn)
      if ((visited.at(-1)?.host ?? "") === "accounts.google.com") {
        // Signing in on that page returns to the Console as the added account.
        if (source.includes("last_project_id")) {
          visited.push(consolePage())
          return { jsonValue: async () => project, dispose: async () => {} }
        }
        return { jsonValue: async () => ({ text: "Sign in with your Google Account" }), dispose: async () => {} }
      }
      if (source.includes("gserviceaccount")) {
        const at = visited.at(-1)
        const byEmail = accounts.find((account) => at?.searchParams.get("authuser") === account)
        return { jsonValue: async () => byEmail ?? added ?? accounts[0], dispose: async () => {} }
      }
      if (source.includes("last_project_id")) return { jsonValue: async () => project, dispose: async () => {} }
      return { jsonValue: async () => ({ text: "Google Cloud Console" }), dispose: async () => {} }
    },
  }
  return { page, visited, close: async () => {} }
}

// The token each gcloud config directory prints stands for that ADC's account,
// so asking Google who a token belongs to answers from the file's directory.
const tokenIsEmail = () => async (url, init) => ({
  ok: true, json: async () => ({ email: String(init.headers.authorization).replace(/^Bearer /, "") }),
})

test("a second sign-in opens Google's add-account page directly and takes the account it returns", async () => {
  const fixture = await fakeGcloud()
  try {
    const first = "first@example.com"
    const second = "second@example.com"
    const own = adcDirectoryFor(second, fixture.directory)
    await fixture.set({ token: first, tokens: { [own]: second } })
    const original = globalThis.fetch
    globalThis.fetch = tokenIsEmail()
    try {
      // The first account already has its ADC in the default directory, so it
      // is the one this machine signed in with: this sign-in adds another.
      await fixture.setAdc()
      const profile = profileOf([first, second])
      const login = await startLogin({ adcRoot: fixture.directory, profile: join(fixture.directory, "profile") }, async () => profile)
      const result = await login.result
      assert.equal(result.account, second)
      // The very first page is Google's add-account page; there is no address
      // to type and no account to pick from a list beforehand.
      assert.equal(profile.visited[0].host, "accounts.google.com")
      assert.equal(profile.visited[0].pathname, "/AddSession")
      assert.equal(profile.visited.filter((url) => url.host === "console.cloud.google.com").length, 1)
      // The second account's ADC went to its own directory.
      assert.equal(await adcFile({ cloudsdkConfig: own }), join(own, "application_default_credentials.json"))
    } finally { globalThis.fetch = original }
  } finally { await fixture.close() }
})

test("adding an account that is already signed in saves nothing", async () => {
  const fixture = await fakeGcloud()
  try {
    const first = "first@example.com"
    await fixture.set({ token: first })
    const original = globalThis.fetch
    globalThis.fetch = tokenIsEmail()
    try {
      await fixture.setAdc()
      // The add-account page comes back as the account this machine already
      // signed in with: nothing is added, and no ADC is written for it.
      const profile = profileOf([first, "second@example.com"], "adc-project", first)
      const login = await startLogin({ adcRoot: fixture.directory, profile: join(fixture.directory, "profile") }, async () => profile)
      const result = await login.result
      assert.equal(result.creditsSession, "unavailable")
      assert.match(result.warning, /first@example\.com is already signed in, so no account was added/)
      assert.ok(!(await fixture.calls()).some((args) => args.includes("login")))
    } finally { globalThis.fetch = original }
  } finally { await fixture.close() }
})

test("approving the consent page as another account saves nothing and keeps no ADC for the wanted one", async () => {
  const fixture = await fakeGcloud()
  try {
    const first = "first@example.com"
    const wanted = "wanted@example.com"
    const own = adcDirectoryFor(wanted, fixture.directory)
    // The consent page is approved as the account already signed in, not the
    // one this sign-in is for.
    await fixture.set({ token: first, approved: first, tokens: { [own]: first } })
    const original = globalThis.fetch
    globalThis.fetch = tokenIsEmail()
    try {
      await fixture.setAdc()
      const profile = profileOf([first, wanted])
      const login = await startLogin({ adcRoot: fixture.directory, profile: join(fixture.directory, "profile") }, async () => profile)
      const result = await login.result
      assert.equal(result.creditsSession, "unavailable")
      assert.match(result.warning, /first@example\.com is already signed in, and the consent page approved that account rather than wanted@example\.com/)
      // Nothing was filed under the wanted account: no ADC, and no directory
      // left behind that a later sign-in would read as one already signed in.
      await assert.rejects(readFile(join(own, "application_default_credentials.json")))
      assert.deepEqual(await readdir(fixture.directory).then((names) => names.filter((name) => name.startsWith("gcp-adc-"))), [])
    } finally { globalThis.fetch = original }
  } finally { await fixture.close() }
})

test("a sign-in refuses to file one account's ADC and cookies under another", async () => {
  const fixture = await fakeGcloud()
  try {
    await fixture.setAdc()
    let closed = 0
    const browser = {
      page: {
        goto: async () => {},
        isClosed: () => false,
        waitForFunction: async (fn) => {
          const source = String(fn)
          if (source.includes("gserviceaccount")) return { jsonValue: async () => "someone-else@example.com", dispose: async () => {} }
          if (source.includes("last_project_id")) return { jsonValue: async () => "adc-project", dispose: async () => {} }
          return { jsonValue: async () => ({ text: "Google Cloud Console" }), dispose: async () => {} }
        },
      },
      close: async () => { closed++ },
    }
    // Chrome holds someone else, and the named account never arrives. The
    // window would stay on Google's add-account page for a person to sign in;
    // a test has nobody to wait for, so its patience is milliseconds.
    const login = await startLogin({ account: "intended@example.com", loginTimeout: 1500 }, async () => browser)
    const result = await login.result
    // Chrome is signed in as another account: the sign-in fails instead of
    // recording intended@example.com over the wrong cookies and ADC.
    assert.equal(result.creditsSession, "unavailable")
    assert.match(result.warning, /signed in as someone-else@example\.com, not intended@example\.com/)
    await login.close()
    assert.equal(closed, 1)
  } finally { await fixture.close() }
})

test("plugin is its own gcp-ai row, not Magpie's built-in Vertex provider", async () => {
  const hooks = await plugin()
  // The built-in google-vertex row keeps its own project, location and ADC
  // path; nothing here renames itself onto it.
  assert.equal(hooks.provider.id, "gcp-ai")
  assert.equal(hooks.auth.provider, "gcp-ai")
  assert.equal(typeof hooks.auth.usage, "function")
  assert.equal(typeof hooks.auth.loader, "function")
  assert.equal(hooks.auth.methods[0].type, "oauth")
  assert.match(hooks.auth.icon, /^data:image\/png;base64,/)
  const config = {}
  await hooks.config(config)
  assert.equal(config.provider["gcp-ai"].name, "GCP AI")
  assert.equal(config.provider["gcp-ai"].npm, "@ai-sdk/openai-compatible")
  const fixture = await fakeGcloud()
  try {
    const usage = await hooks.auth.usage(async () => ({ type: "oauth" }), { options: { billingAccount: "invalid" } })
    assert.equal(usage.signIn, "kept")
    assert.match(usage.error, /billing account ID/)
  } finally { await fixture.close() }
})

test("models are what Google's catalog lists and the project answers for, not a seeded list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-models-test-"))
  const previousCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = directory
  try {
    // A cached discovery is returned as it was read, without asking Google.
    const file = join(directory, "magpie", "gcp-ai", "models-" + createHash("sha256").update(JSON.stringify(["", "", ""])).digest("hex").slice(0, 16) + ".json")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ project: "example-project", ids: ["gemini-4-argon", "gemini-3.8-flash"], fetchedAt: new Date().toISOString() }))
    assert.deepEqual((await availableModels({})).ids, ["gemini-4-argon", "gemini-3.8-flash"])
    // Speech, transcription, translation, embeddings, live and image models
    // are not chat models, however Google lists them.
    const models = toProviderModels(["gemini-4-argon", "gemini-3.8-flash"], { "gemini-4-argon": { name: "Gemini 4 Argon", limit: { context: 1048576, output: 65536 }, cost: { input: 2, output: 10, cache_read: 0.1 }, reasoning_options: [{ type: "effort", values: ["low", "high"] }] } }, "gcp-ai")
    assert.deepEqual(Object.keys(models).sort(), ["gemini-3.8-flash", "gemini-4-argon"])
    // Newest first, by the catalog's release date; a model it doesn't describe
    // goes after the ones it does.
    const dated = { "gemini-2.5-pro": { release_date: "2025-06-17" }, "gemini-4-argon": { release_date: "2026-10-13" } }
    assert.deepEqual(Object.keys(toProviderModels(["gemini-2.5-pro", "undated", "gemini-4-argon"], dated, "gcp-ai")), ["gemini-4-argon", "gemini-2.5-pro", "undated"])
    assert.equal(models["gemini-4-argon"].api.id, "google/gemini-4-argon")
    assert.equal(models["gemini-4-argon"].limit.context, 1048576)
    assert.deepEqual(Object.keys(models["gemini-4-argon"].variants), ["low", "high"])
    // A model the catalog doesn't know is still listed, from Google's id alone.
    assert.equal(models["gemini-3.8-flash"].name, "gemini-3.8-flash")
    assert.equal(models["gemini-3.8-flash"].api.id, "google/gemini-3.8-flash")
  } finally {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCache
    await rm(directory, { recursive: true, force: true })
  }
})
