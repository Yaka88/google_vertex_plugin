import "./network.mjs"
import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../index.mjs"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { EventEmitter } from "node:events"
import { accountOf, adcDirectoryFor, adcDirectoryOwnedBy, adcDirectoryToCreate, adcFile, adcSlug, beginAdcLogin, effectiveAuthMode, hasAdc, resolveAccount, resolveIdentity, resolveProject, runGcloud, startLogin, tokenProvider } from "../lib/credentials.mjs"
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

test("gcloud resolves explicit and configured identities and rejects missing or malformed configuration", { timeout: 30000 }, async () => {
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

test("gcloud tokens merge concurrent requests and delegate expiry checks and renewal to gcloud", { timeout: 30000 }, async () => {
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

test("CLI verifies gcloud without exposing tokens and rejects all removed key flags", { timeout: 30000 }, async () => {
  for (const flag of ["--source-key", "--key-path", "--service-account"]) {
    await assert.rejects(main(["credentials", flag, "/unused.json"]), /Unknown option/)
  }
  const fixture = await fakeGcloud()
  const originalLog = console.log
  let output
  try {
    console.log = (value) => { output = JSON.parse(value) }
    await main(["credentials", "--account", "selected@example.com"])
    assert.deepEqual(output, { project: "example-project", account: "selected@example.com", source: "gcloud", authMode: "gcloud", inferenceAuth: "token-verified" })
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

test("ADC setup reads gcloud's complete consent URL and distinguishes saved ADC from failed consent", { timeout: 30000 }, async () => {
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
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
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
    const login = await beginAdcLogin({ project: "example-project" }, run)
    const url = await login.url
    await login.done
    // One URL opened, from gcloud's own flow; BROWSER is neutralised so the
    // plugin's Chrome, and not a second window gcloud starts, shows it.
    assert.match(url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?response_type=code&client_id=x/)
    assert.equal(calls[0].command, "gcloud")
    assert.deepEqual(calls[0].args, ["auth", "application-default", "login", "--project=example-project", "--billing-project=example-project"])
    assert.equal(calls[0].env.BROWSER, "true")
    // A chunk boundary is not the end of the URL: nothing is opened until the
    // whole address has arrived.
    const split = (pieces, code) => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}
      setTimeout(() => { for (const piece of pieces) child.stderr.emit("data", piece) }, 5)
      setTimeout(() => child.emit("exit", code), 40)
      return child
    }
    const slow = (pieces) => split([...pieces, "\n"], 0)
    const splitLogin = await beginAdcLogin({}, () => slow(["https://accounts.google.com/o/oauth2/auth?response_type=code", "&client_id=x&state=y"]))
    const splitUrl = await splitLogin.url
    await splitLogin.done
    // The newline gcloud ends the URL with is not part of the address.
    assert.match(splitUrl, /client_id=x&state=y$/)
    // ADC written before gcloud's own quota-project probe failed: the sign-in
    // worked, so the exit code is not the answer.
    await fixture.clearAdc()
    const writesThenFails = () => {
      const child = split(["https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x&state=y\n"], 1)
      setTimeout(() => { void fixture.setAdc({ quota_project_id: "adc-project" }) }, 5)
      return child
    }
    await (await beginAdcLogin({}, writesThenFails)).done
    // Nothing written: that is a real failure.
    await fixture.clearAdc()
    await assert.rejects((await beginAdcLogin({}, () => split(["https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x&state=y\n"], 1))).done, /gcloud could not set up ADC/)
    await assert.rejects((await beginAdcLogin({}, missing)).done, /gcloud CLI was not found/)
  } finally { await fixture.close() }
})

test("ADC uses only its own token command, never assumes the active gcloud account, and adds ADC only when there is none", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  let login
  try {
    await fixture.setAdc({})
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
    login = await startLogin({ project: "example-project", account: "user@example.com", authMode: "gcloud" }, signInWindowOf([]))
    const result = await login.result
    // An explicit gcloud sign-in is the user's own: the window opened and was
    // read for the gcloud identity, and no ADC login was run for them.
    assert.equal(result.project, "example-project")
    assert.equal(result.creditsSession, "ready")
    assert.ok(!(await fixture.calls()).some((args) => args.includes("login")))
    await assert.rejects(tokenProvider({ authMode: "unknown" })(), /must be auto, gcloud or adc/)
  } finally { await login?.close(); await fixture.close() }
})

test("auto mode prefers ADC like official Vertex clients, takes its quota project, and falls back to gcloud", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  try {
    // No ADC file: the gcloud user login remains the identity.
    assert.equal(await effectiveAuthMode(), "gcloud")
    assert.deepEqual(await resolveIdentity(), { project: "example-project", account: "user@example.com", source: "gcloud", authMode: "gcloud" })
    // ADC exists: it wins, and its project resolves from gcloud config (ADC's quota project is for billing quota, not Vertex project selection).
    await fixture.setAdc({ quota_project_id: "adc-project" })
    assert.equal(await effectiveAuthMode(), "adc")
    assert.deepEqual(await resolveIdentity(), { project: "example-project", source: "gcloud", authMode: "adc" })
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

test("a sign-in with an ADC the plugin already filed counts as an overwrite and fails", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  let login
  const original = globalThis.fetch
  globalThis.fetch = mockFetch()
  const root = join(fixture.directory, "plugin")
  try {
    // The plugin's own ADC for this account is the overwrite. gcloud's
    // machine-wide one is not: it belongs to gcloud, is only ever read, and a
    // sign-in writes this plugin's credential beside it.
    const own = adcDirectoryFor("user@example.com", root)
    await mkdir(own, { recursive: true })
    await writeFile(join(own, "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "secret", refresh_token: "refresh" }))
    const visited = []
    const openWindow = async ({ url }) => {
      visited.push(new URL(url))
      return {
        ended: new Promise((resolve) => setTimeout(resolve, 5)),
        openTab: async () => true,
        close: async () => {},
      }
    }
    login = await startLogin({ adcRoot: root, account: "user@example.com" }, openWindow)
    const result = await login.result
    assert.equal(result.creditsSession, "unavailable")
    assert.match(result.warning, /already signed in|ADC already existed/i)
    // Refused before anything opened: no window, and the ADC is as it was.
    assert.deepEqual(visited, [])
    assert.equal(await readFile(join(own, "application_default_credentials.json"), "utf8").then((text) => JSON.parse(text).refresh_token), "refresh")
  } finally { await login?.close(); globalThis.fetch = original; await fixture.close() }
})

test("ADC reads and new directories stay under the plugin root, independent of machine credentials", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  const root = join(fixture.directory, "plugin")
  const original = globalThis.fetch
  globalThis.fetch = mockFetch()
  try {
    for (const account of ["first@example.com", "second@example.com"]) {
      const own = adcDirectoryFor(account, root)
      assert.equal(await adcDirectoryOwnedBy(account, root), own)
      assert.equal(await adcDirectoryToCreate(account, root), own)
    }
    const own = adcDirectoryFor("first@example.com", root)
    await mkdir(own, { recursive: true })
    await writeFile(join(own, "application_default_credentials.json"), "{}")
    await fixture.set({ token: "first@example.com" })
    assert.equal(await adcDirectoryOwnedBy("first@example.com", root), own)
    assert.equal(await adcDirectoryToCreate("first@example.com", root), own)
    assert.equal(await adcDirectoryOwnedBy("second@example.com", root), adcDirectoryFor("second@example.com", root))
    // A machine ADC is readable as an import, never the destination of a new
    // account, even when CLOUDSDK_CONFIG points somewhere else.
    await fixture.setAdc()
    process.env.CLOUDSDK_CONFIG = join(fixture.directory, "someone-elses-sdk")
    assert.equal(await adcFile(), join(fixture.sdk, "application_default_credentials.json"))
    assert.equal(await adcDirectoryToCreate("third@example.com", root), adcDirectoryFor("third@example.com", root))
    const named = join(fixture.directory, "own-sdk")
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(fixture.directory, "elsewhere.json")
    assert.equal(await adcFile({ cloudsdkConfig: named }), join(named, "application_default_credentials.json"))
    assert.equal(await hasAdc({ cloudsdkConfig: named }), false)
  } finally {
    globalThis.fetch = original
    await fixture.close()
  }
})

// The one window a sign-in opens. Nothing is attached to it, so what it offers
// is the address it was opened on, the tabs handed to it afterwards (gcloud's
// consent page), and the moment it ends — which, for a person who has just
// signed in, is immediately.
function signInWindowOf(visited, tabs = []) {
  const opened = new Promise((resolve) => setTimeout(resolve, 5))
  return async ({ url }) => {
    visited.push(new URL(url))
    return {
      ended: opened,
      openTab: async (tabUrl) => { tabs.push(tabUrl); return true },
      close: async () => {},
    }
  }
}


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

// Routes fetch requests by URL host for testing sign-in and project listing.
const mockFetch = (projects = [{ projectId: "example-project", name: "Example Project", lifecycleState: "ACTIVE" }]) => async (url, init) => {
  const parsed = new URL(url)
  if (parsed.host === "openidconnect.googleapis.com") {
    return {
      ok: true,
      json: async () => ({ email: String(init.headers.authorization).replace(/^Bearer /, "") }),
    }
  }
  if (parsed.host === "cloudresourcemanager.googleapis.com") {
    return {
      ok: true,
      json: async () => ({ projects }),
    }
  }
  if (parsed.host === "serviceusage.googleapis.com") {
    const match = parsed.pathname.match(/\/v1\/projects\/([^/]+)\/services\/aiplatform\.googleapis\.com/)
    const projectId = match ? decodeURIComponent(match[1]) : undefined
    const candidate = projects.find((p) => p.projectId === projectId)
    const enabled = candidate ? candidate.vertexEnabled !== false : false
    return {
      ok: true,
      json: async () => ({ state: enabled ? "ENABLED" : "DISABLED" }),
    }
  }
  return { ok: false, status: 404 }
}

test("a named sign-in saves its own ADC and refuses a later duplicate", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  let login
  let duplicate
  const original = globalThis.fetch
  globalThis.fetch = mockFetch()
  try {
    const account = "me@example.com"
    const root = join(fixture.directory, "plugin")
    const own = adcDirectoryFor(account, root)
    await fixture.set({ approved: account })
    const visited = []
    login = await startLogin({ adcRoot: root, account }, signInWindowOf(visited))
    assert.deepEqual(await login.result, {
      project: "example-project", account, source: "gcloud", authMode: "adc", cloudsdkConfig: own, creditsSession: "ready",
    })
    assert.equal(visited.length, 1)
    const file = join(own, "application_default_credentials.json")
    const saved = await readFile(file, "utf8")
    assert.equal(JSON.parse(saved).approved, account)
    assert.equal(await adcDirectoryOwnedBy(account, root), own)
    duplicate = await startLogin({ adcRoot: root, account }, signInWindowOf(visited))
    assert.match((await duplicate.result).warning, /already signed in/)
    assert.equal(visited.length, 1)
    assert.equal(await readFile(file, "utf8"), saved)
    assert.deepEqual(await readdir(root), ["adc-me-example-com"])
  } finally { await login?.close(); await duplicate?.close(); globalThis.fetch = original; await fixture.close() }
})

for (const named of [true, false]) {
  test(`accounts with the same slug keep separate ADCs after ${named ? "named" : "unnamed"} sign-ins`, { timeout: 30000 }, async () => {
    const fixture = await fakeGcloud()
    const original = globalThis.fetch
    globalThis.fetch = mockFetch()
    try {
      const root = join(fixture.directory, "plugin")
      const first = "a.b@x.com"
      const second = "a-b@x.com"
      const plain = adcDirectoryFor(first, root)
      const hashed = `${plain}-${createHash("sha256").update(second).digest("hex").slice(0, 6)}`
      assert.equal(adcSlug(first), adcSlug(second))
      const visited = []
      const signIn = async (account) => {
        await fixture.set({ approved: account })
        const login = await startLogin({ adcRoot: root, ...(named ? { account } : {}) }, signInWindowOf(visited))
        try { return await login.result } finally { await login.close() }
      }
      const one = await signIn(first)
      assert.equal(one.account, first)
      assert.equal(one.cloudsdkConfig, plain)
      assert.equal(one.creditsSession, "ready")
      const saved = await readFile(join(plain, "application_default_credentials.json"), "utf8")
      // A definite mismatch chooses the second account's directory even before
      // it exists; reading must never borrow the first account's ADC.
      assert.equal(await adcDirectoryOwnedBy(second, root), hashed)
      assert.equal(await adcDirectoryToCreate(second, root), hashed)
      const two = await signIn(second)
      assert.equal(two.account, second)
      assert.equal(two.cloudsdkConfig, hashed)
      assert.equal(two.project, "example-project")
      assert.equal(two.creditsSession, "ready")
      assert.equal(visited.length, 2)
      for (const [account, directory] of [[first, plain], [second, hashed]]) {
        assert.equal(await adcDirectoryOwnedBy(account, root), directory)
        assert.equal(await adcDirectoryToCreate(account, root), directory)
        assert.equal(await tokenProvider({ authMode: "adc", cloudsdkConfig: directory })(), account)
        const duplicate = await signIn(account)
        assert.equal(duplicate.project, undefined)
        assert.match(duplicate.warning, /already signed in/)
      }
      assert.equal(await readFile(join(plain, "application_default_credentials.json"), "utf8"), saved)
      assert.equal(JSON.parse(await readFile(join(hashed, "application_default_credentials.json"), "utf8")).approved, second)
      assert.deepEqual((await readdir(root)).sort(), [plain, hashed].map((directory) => directory.slice(root.length + 1)).sort())
    } finally { globalThis.fetch = original; await fixture.close() }
  })
}

test("a sign-in without gcloud finishes promptly, opens no window, and removes its directory", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  const original = globalThis.fetch
  globalThis.fetch = async () => assert.fail("A missing gcloud must not make a Google request")
  try {
    const root = join(fixture.directory, "plugin")
    const empty = join(fixture.directory, "empty-path")
    await mkdir(empty)
    process.env.PATH = empty
    for (const account of [undefined, "me@example.com"]) {
      const visited = []
      const login = await startLogin({ adcRoot: root, account, loginTimeout: 20000 }, signInWindowOf(visited))
      let timer
      try {
        const result = await Promise.race([
          login.result,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Missing gcloud left sign-in pending")), 2000) }),
        ])
        assert.equal(result.project, undefined)
        assert.equal(result.creditsSession, "unavailable")
        assert.match(result.warning, /gcloud CLI was not found/)
        assert.deepEqual(visited, [])
        assert.deepEqual(await readdir(root), [])
      } finally { clearTimeout(timer); await login.close() }
    }
  } finally { globalThis.fetch = original; await fixture.close() }
})

test("a second sign-in opens Google's add-account page directly and takes the account it returns", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  let login
  try {
    const first = "first@example.com"
    const second = "second@example.com"
    const root = join(fixture.directory, "plugin")
    const own = adcDirectoryFor(second, root)
    // The consent page is approved as the second account: that is the token the
    // staging directory prints, and the only place the account is learned from.
    await fixture.set({ token: first, pendingToken: second })
    const original = globalThis.fetch
    globalThis.fetch = mockFetch()
    try {
      // An account this plugin already filed is what makes a sign-in an
      // addition; the machine's own ADC is not this plugin's account list, so
      // it would not put the add-account page in front of the sign-in.
      const known = adcDirectoryFor(first, root)
      await mkdir(known, { recursive: true })
      await writeFile(join(known, "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "secret", refresh_token: "refresh" }))
      const visited = []
      const tabs = []
      login = await startLogin({ adcRoot: root, profile: join(fixture.directory, "profile") }, signInWindowOf(visited, tabs, second))
      const result = await login.result
      assert.equal(result.account, second)
      // The very first page is Google's add-account page; there is no address
      // to type and no account to pick from a list beforehand.
      assert.equal(visited[0].host, "accounts.google.com")
      assert.equal(visited[0].pathname, "/AddSession")
      // One window: the account is learned from the token the consent page
      // produced, so nothing else is opened to ask who it is.
      assert.equal(visited.length, 1)
      // (The consent tab itself is covered where gcloud's URL is read: the
      // fixture's gcloud writes ADC without printing one.)
      assert.deepEqual(tabs, [])
      // The second account's ADC went to its own directory, and no staging
      // directory was left behind.
      assert.equal(await adcFile({ cloudsdkConfig: own }), join(own, "application_default_credentials.json"))
      assert.deepEqual((await readdir(root)).filter((name) => name.includes("pending")), [])
    } finally { await login?.close(); globalThis.fetch = original }
  } finally { await fixture.close() }
})

test("a sign-in whose ADC names an account not signed in here is a new account", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  let login
  try {
    const email = "unwritten@example.com"
    const root = join(fixture.directory, "plugin")
    await fixture.clearAdc()
    await fixture.set({ token: email, pendingToken: email })
    const original = globalThis.fetch
    globalThis.fetch = mockFetch()
    try {
      login = await startLogin({ adcRoot: root, profile: join(fixture.directory, "profile") }, signInWindowOf([], []))
      const result = await login.result
      assert.equal(result.account, email)
      assert.equal(result.creditsSession, "ready")
    } finally { await login?.close(); globalThis.fetch = original }
  } finally { await fixture.close() }
})

test("adding an account whose ADC lives in machine config succeeds", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  let login
  try {
    const first = "first@example.com"
    const root = join(fixture.directory, "plugin")
    await fixture.set({ token: first, pendingToken: first })
    const original = globalThis.fetch
    globalThis.fetch = mockFetch()
    try {
      await fixture.setAdc()
      // Machine ADC does not make an account already signed in, so it can be added.
      login = await startLogin({ adcRoot: root, profile: join(fixture.directory, "profile") }, signInWindowOf([]))
      const result = await login.result
      assert.equal(result.account, first)
      assert.equal(result.creditsSession, "ready")
    } finally { await login?.close(); globalThis.fetch = original }
  } finally { await fixture.close() }
})

test("an account whose project list has no Vertex-enabled project fails the sign-in, registers nothing, and leaves no ADC directory behind", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  let login
  try {
    const email = "noproject@example.com"
    const root = join(fixture.directory, "plugin")
    await fixture.clearAdc()
    await fixture.set({ token: email, pendingToken: email })
    const original = globalThis.fetch
    globalThis.fetch = mockFetch([])
    try {
      login = await startLogin({ adcRoot: root, profile: join(fixture.directory, "profile") }, signInWindowOf([], []))
      const result = await login.result
      assert.equal(result.creditsSession, "unavailable")
      assert.match(result.warning, /has Vertex AI enabled|Create a Google Cloud project and enable the Vertex AI API/i)
      assert.deepEqual(await readdir(root).catch(() => []), [])
    } finally { await login?.close(); globalThis.fetch = original }
  } finally { await fixture.close() }
})

test("a consent page approved as another account saves nothing and keeps no ADC for the wanted one", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  let login
  try {
    const wanted = "wanted@example.com"
    const other = "other@example.com"
    const root = join(fixture.directory, "plugin")
    const own = adcDirectoryFor(wanted, root)
    // This machine's own gcloud sign-in is the account the row named; the
    // consent page is approved as someone else, and the token written for that
    // row says so.
    await fixture.set({ token: wanted, pendingToken: other })
    const original = globalThis.fetch
    globalThis.fetch = mockFetch()
    try {
      login = await startLogin({ adcRoot: root, account: wanted, profile: join(fixture.directory, "profile") }, signInWindowOf([]))
      const result = await login.result
      assert.equal(result.creditsSession, "unavailable")
      assert.match(result.warning, /consent page approved other@example\.com, not wanted@example\.com/)
      // Nothing was filed under the wanted account, and no directory is left
      // that a later sign-in would read as one already signed in.
      await assert.rejects(readFile(join(own, "application_default_credentials.json")))
      for (const name of await readdir(root).catch(() => [])) {
        await assert.rejects(readFile(join(root, name, "application_default_credentials.json")), `${name} still holds an ADC`)
      }
    } finally { await login?.close(); globalThis.fetch = original }
  } finally { await fixture.close() }
})

// A gcloud config directory holds far more than ADC: the named configurations
// and the credential database behind every `gcloud auth login` on the machine.
// A sign-in that has to undo what it wrote must undo exactly one file.
test("a sign-in that saves nothing leaves the user's gcloud config directory untouched", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  let login
  const sdk = join(fixture.directory, "users-gcloud")
  try {
    await mkdir(join(sdk, "configurations"), { recursive: true })
    await writeFile(join(sdk, "configurations", "config_default"), "[core]\nproject = kept-project\n")
    await writeFile(join(sdk, "credentials.db"), "kept-credential-database")
    // The consent page approves someone other than the account the row named.
    await fixture.set({ token: "other@example.com", pendingToken: "other@example.com" })
    const original = globalThis.fetch
    globalThis.fetch = mockFetch()
    try {
      login = await startLogin({ adcRoot: join(fixture.directory, "plugin"), cloudsdkConfig: sdk, account: "me@example.com", profile: join(fixture.directory, "profile") }, signInWindowOf([]))
      const result = await login.result
      assert.equal(result.creditsSession, "unavailable")
      assert.match(result.warning, /consent page approved other@example\.com, not me@example\.com/)
      // Nothing of the user's was removed.
      assert.equal(await readFile(join(sdk, "credentials.db"), "utf8"), "kept-credential-database")
      assert.equal(await readFile(join(sdk, "configurations", "config_default"), "utf8"), "[core]\nproject = kept-project\n")
      // And the ADC file this run wrote is gone, with the directory it made.
      await assert.rejects(readFile(join(fixture.directory, "plugin", "adc-me-example-com", "application_default_credentials.json")))
    } finally { await login?.close(); globalThis.fetch = original }
  } finally { await fixture.close() }
})

test("a sign-in refuses to file one account's ADC and cookies under another", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  let login
  try {
    // No ADC yet, so this run would write one; the consent page approves
    // someone else, and the token is the only thing that can say so. That
    // account is not one this machine already signed in with, so the refusal
    // is about the mismatch and not about adding a duplicate.
    await fixture.clearAdc()
    await fixture.set({ token: "someone-else@example.com", pendingToken: "someone-else@example.com", approved: "someone-else@example.com" })
    const original = globalThis.fetch
    globalThis.fetch = mockFetch()
    try {
      let closed = 0
      const openWindow = async () => ({
        ended: new Promise((resolve) => setTimeout(resolve, 5)),
        openTab: async () => true,
        close: async () => { closed++ },
      })
      const root = join(fixture.directory, "plugin")
      login = await startLogin({ account: "intended@example.com", adcRoot: root, profile: join(fixture.directory, "profile") }, openWindow)
      const result = await login.result
      // The consent page approved another account: the sign-in fails instead of
      // recording intended@example.com over the wrong cookies and ADC.
      assert.equal(result.creditsSession, "unavailable")
      assert.match(result.warning, /consent page approved someone-else@example\.com, not intended@example\.com/)
      // Nothing was filed under the account that was wanted.
      assert.deepEqual(await readdir(root).catch(() => []), [])
      await login.close()
      assert.equal(closed, 1)
    } finally { await login?.close(); globalThis.fetch = original }
  } finally { await fixture.close() }
})

// Exercise the model fallback with a real fixture token and an offline response;
// "invalid" is syntactically a valid project ID, so it does not stop discovery.
test("plugin is its own gcp-ai row, not Magpie's built-in Vertex provider", { timeout: 30000 }, async () => {
  const hooks = await plugin()
  // The built-in google-vertex row keeps its own project, location and ADC
  // path; nothing here renames itself onto it.
  assert.equal(hooks.provider.id, "gcp-ai")
  assert.equal(hooks.auth.provider, "gcp-ai")
  assert.equal(typeof hooks.auth.usage, "function")
  assert.equal(typeof hooks.auth.loader, "function")
  assert.equal(hooks.auth.methods[0].type, "oauth")
  assert.match(hooks.auth.icon, /^data:image\/png;base64,/)
  // No switches: there is nothing for a user to turn on before the row works.
  assert.equal(hooks.auth.options, undefined)
  const config = {}
  await hooks.config(config)
  assert.equal(config.provider["gcp-ai"].name, "GCP AI")
  assert.equal(config.provider["gcp-ai"].npm, "@ai-sdk/google")
  // A row Magpie configured with no models stays empty until someone presses
  // Fetch models, so the config hook hands over Google's current catalog. The
  // provider hook replaces it with what the signed-in project can call.
  const seeded = config.provider["gcp-ai"].models
  assert.equal(seeded["gemini-4-argon"].name, "Gemini 4 Argon")
  assert.deepEqual(seeded["gemini-4-argon"].variants, { low: { reasoning_effort: "low" }, medium: { reasoning_effort: "medium" }, high: { reasoning_effort: "high" } })
  assert.equal(seeded["gemini-2.5-pro"].reasoning, false)
  // Retired models are in no list: the catalog still names them and calling one
  // answers 404, so a seed carrying them would offer models that cannot load.
  for (const gone of ["gemini-1.5-pro-002", "gemini-2.5-flash-preview-04-17", "gemini-2.5-pro-exp-03-25"]) assert.equal(seeded[gone], undefined)
  // Twelve chat models, and no speech, image, transcription or embedding model.
  assert.equal(Object.keys(seeded).length, 12)
  assert.equal(Object.keys(seeded).filter((id) => /tts|embedding|transcribe|image|live|translate|nano-banana|omni/.test(id)).length, 0)
  // The provider hook is handed the whole provider info, not its models. A
  // failure must give back provider.models: handing back the object made
  // magpie read its keys as model ids and offer "id", "name" and "source" as
  // models on the row.
  const previousCache = process.env.XDG_CACHE_HOME
  const directory = await mkdtemp(join(tmpdir(), "vertex-fallback-"))
  process.env.XDG_CACHE_HOME = join(directory, "cache")
  const fixture = await fakeGcloud()
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; return { ok: false, status: 403 } }
  try {
    await fixture.setAdc()
    const info = { id: "gcp-ai", name: "GCP AI", source: "config", models: { "gemini-2.5-flash": { id: "gemini-2.5-flash" } } }
    const fallback = await hooks.provider.models(info, { auth: { authMode: "adc", project: "invalid" } })
    assert.deepEqual(fallback, info.models)
    assert.equal(fallback.id, undefined)
    assert.equal(fallback.source, undefined)
    assert.equal(requests, 1)
  } finally {
    globalThis.fetch = original
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCache
  }
  const usageFixture = await fakeGcloud()
  try {
    // No switch stands between the row and its balance: asking for usage reads
    // the Console, which here reaches the billing-account check.
    const usage = await hooks.auth.usage(async () => ({ type: "oauth" }), { options: { billingAccount: "invalid" } })
    assert.equal(usage.signIn, "kept")
    assert.match(usage.error, /billing account ID/)
    // Nothing magpie hands the plugin turns the read off: a plugin options JSON
    // and a row option both leave it reading.
    const fromOptions = await plugin({}, { credits: false })
    const still = await fromOptions.auth.usage(async () => ({ type: "oauth" }), { options: { billingAccount: "invalid" } })
    assert.match(still.error, /billing account ID/)
    const fromRow = await plugin({ magpie: { option: () => false } })
    const reads = await fromRow.auth.usage(async () => ({ type: "oauth" }), { options: { billingAccount: "invalid" } })
    assert.match(reads.error, /billing account ID/)
  } finally { await usageFixture.close() }
})

test("models are Google's catalog per project and location, newest first, dressed with the catalog's numbers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-models-test-"))
  const previousCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = directory
  try {
    // A cached discovery is returned as it was read, without asking Google.
    // The location is part of the cache's identity, because the same project
    // serves a different list in each one.
    const key = (location) => "models-" + createHash("sha256").update(JSON.stringify(["", "", "", location])).digest("hex").slice(0, 16) + ".json"
    const file = join(directory, "magpie", "gcp-ai", key("global"))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ project: "example-project", ids: ["gemini-4-argon", "gemini-3.8-flash"], fetchedAt: new Date().toISOString() }))
    assert.deepEqual((await availableModels({ location: "global" })).ids, ["gemini-4-argon", "gemini-3.8-flash"])
    // A region's list is not the global one: it is asked for separately.
    await writeFile(join(directory, "magpie", "gcp-ai", key("us-central1")), JSON.stringify({ project: "example-project", ids: ["gemini-regional"], fetchedAt: new Date().toISOString() }))
    assert.deepEqual((await availableModels({ location: "us-central1" })).ids, ["gemini-regional"])
    await assert.rejects(availableModels({ location: "not a region" }), /GOOGLE_VERTEX_LOCATION/)
    // Speech, transcription, translation, embeddings, live and image models
    // are not chat models, however Google lists them.
    const models = toProviderModels(["gemini-4-argon", "gemini-3.8-flash"], { "gemini-4-argon": { name: "Gemini 4 Argon", limit: { context: 1048576, output: 65536 }, cost: { input: 2, output: 10, cache_read: 0.1 }, reasoning_options: [{ type: "effort", values: ["low", "high"] }] } }, "gcp-ai")
    assert.deepEqual(Object.keys(models).sort(), ["gemini-3.8-flash", "gemini-4-argon"])
    // Newest first, by the catalog's release date; a model it doesn't describe
    // goes after the ones it does.
    const dated = { "gemini-2.5-pro": { release_date: "2025-06-17" }, "gemini-4-argon": { release_date: "2026-10-13" } }
    assert.deepEqual(Object.keys(toProviderModels(["gemini-2.5-pro", "undated", "gemini-4-argon"], dated, "gcp-ai")), ["gemini-4-argon", "gemini-2.5-pro", "undated"])
    assert.equal(models["gemini-4-argon"].api.id, "gemini-4-argon")
    assert.equal(models["gemini-4-argon"].api.npm, "@ai-sdk/google")
    assert.equal(models["gemini-4-argon"].limit.context, 1048576)
    assert.deepEqual(Object.keys(models["gemini-4-argon"].variants), ["low", "high"])
    // A model the catalog doesn't know is still listed, from Google's id alone.
    assert.equal(models["gemini-3.8-flash"].name, "gemini-3.8-flash")
    assert.equal(models["gemini-3.8-flash"].api.id, "gemini-3.8-flash")
  } finally {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCache
    await rm(directory, { recursive: true, force: true })
  }
})

test("a retired model Google still lists is left out, and only a 404 counts as gone", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-probe-test-"))
  const previousCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = directory
  const original = globalThis.fetch
  const fixture = await fakeGcloud()
  try {
    await fixture.setAdc()
    // The catalog names four models. probed answers for each: a live model
    // takes the token count, a retired one is NOT_FOUND, one this account may
    // not call is FORBIDDEN, and one drops the connection.
    const catalog = ["gemini-4-argon", "gemini-1.5-pro-002", "gemini-3.5-flash", "gemini-2.5-pro"]
    const answer = { "gemini-4-argon": 200, "gemini-1.5-pro-002": 404, "gemini-3.5-flash": 403, "gemini-2.5-pro": -1 }
    const asked = []
    globalThis.fetch = async (url) => {
      const parsed = new URL(url)
      if (parsed.host !== "aiplatform.googleapis.com") return { ok: false, status: 404, json: async () => ({}) }
      if (parsed.pathname.endsWith("/publishers/google/models")) {
        return { ok: true, json: async () => ({ publisherModels: catalog.map((id) => ({ name: `publishers/google/models/${id}` })) }) }
      }
      const id = parsed.pathname.match(/models\/([^:]+):countTokens$/)?.[1]
      asked.push(id)
      const status = answer[id]
      if (status === -1) throw Object.assign(new Error("fetch failed"), { name: "TimeoutError" })
      return { ok: status === 200, status, json: async () => ({ totalTokens: 1 }) }
    }
    const listed = await availableModels({ project: "example-project", location: "global", authMode: "adc", force: true })
    // A model answering NOT_FOUND is not deployed and is dropped. FORBIDDEN, a
    // dropped connection and a timeout are not answers about the model, so
    // those stay: losing a working model to a bad minute is worse than listing
    // one that may refuse.
    assert.deepEqual(listed.ids, ["gemini-4-argon", "gemini-3.5-flash", "gemini-2.5-pro"])
    assert.deepEqual(asked.sort(), [...catalog].sort())
    // Nothing was generated: the probe reads the request, it does not bill one.
    assert.equal(asked.length, catalog.length)
  } finally {
    globalThis.fetch = original
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCache
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("every model answering 404 is a broken read, not an empty provider", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-probe-all-test-"))
  const previousCache = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = directory
  const original = globalThis.fetch
  const fixture = await fakeGcloud()
  try {
    await fixture.setAdc()
    // A wrong project or location answers NOT_FOUND for the whole catalog. That
    // is the read being wrong, not the project having no models, so Google's
    // names are kept rather than the row being emptied.
    globalThis.fetch = async (url) => {
      const parsed = new URL(url)
      if (parsed.host !== "aiplatform.googleapis.com") return { ok: false, status: 404, json: async () => ({}) }
      if (parsed.pathname.endsWith("/publishers/google/models")) {
        return { ok: true, json: async () => ({ publisherModels: [{ name: "publishers/google/models/gemini-4-argon" }, { name: "publishers/google/models/gemini-2.5-pro" }] }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    const listed = await availableModels({ project: "example-project", location: "global", authMode: "adc", force: true })
    assert.deepEqual(listed.ids, ["gemini-4-argon", "gemini-2.5-pro"])
  } finally {
    globalThis.fetch = original
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCache
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("closing a login waits for its pending identity work before fetch is restored", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  const original = globalThis.fetch
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let login
  globalThis.fetch = async (...args) => {
    entered.resolve()
    await release.promise
    return mockFetch()(...args)
  }
  try {
    await fixture.set({ approved: "closing@example.com" })
    login = await startLogin({ adcRoot: join(fixture.directory, "plugin"), account: "closing@example.com" }, signInWindowOf([]))
    await entered.promise
    let closed = false
    const closing = login.close().then(() => { closed = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(closed, false, "close returned while identity lookup was still running")
    release.resolve()
    await closing
    assert.equal(closed, true)
    assert.equal((await login.result).project, undefined)
  } finally {
    release.resolve()
    await login?.close()
    globalThis.fetch = original
    await fixture.close()
  }
})

test("account settings beat the row, and row settings beat environment defaults", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  const original = globalThis.fetch
  const previousCache = process.env.XDG_CACHE_HOME
  const options = {
    project: "row-project", location: "us-central1", account: "row@example.com", authMode: "gcloud",
    billingAccount: "AAAAAA-BBBBBB-CCCCCC", profile: join(fixture.directory, "row-profile"), cloudsdkConfig: fixture.sdk,
  }
  const auth = {
    project: "account-project", location: "europe-west1", accountId: "account@example.com", account: "legacy@example.com", authMode: "adc",
    billingAccount: "DDDDDD-EEEEEE-FFFFFF", profile: join(fixture.directory, "account-profile"), cloudsdkConfig: join(fixture.directory, "account-sdk"),
  }
  const requests = []
  globalThis.fetch = async (input) => {
    requests.push(String(input))
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    process.env.XDG_CACHE_HOME = join(fixture.directory, "cache")
    process.env.GOOGLE_VERTEX_PROJECT = "environment-project"
    process.env.GOOGLE_VERTEX_LOCATION = "asia-east1"
    process.env.VERTEX_GCLOUD_ACCOUNT = "environment@example.com"
    process.env.VERTEX_GCLOUD_AUTH_MODE = "invalid-mode"
    process.env.VERTEX_BILLING_ACCOUNT = "invalid-billing"
    process.env.VERTEX_CHROME_PROFILE = join(fixture.directory, "environment-profile")
    await mkdir(auth.cloudsdkConfig)
    await writeFile(join(auth.cloudsdkConfig, "application_default_credentials.json"), "{}")
    await fixture.set({ tokens: { [auth.cloudsdkConfig]: "account-token" } })
    const hooks = await plugin()
    for (const [record, expected] of [[auth, { ...auth, account: auth.accountId }], [{ ...auth, accountId: undefined }, auth], [{}, options]]) {
      const loaded = await hooks.auth.loader(async () => record, { options })
      assert.ok(loaded.baseURL.includes(`/projects/${expected.project}/locations/${expected.location}/`))
      const calls = await fixture.calls()
      assert.ok(calls.some((args) => expected.authMode === "adc" ? args.includes("application-default") : args.includes(`--account=${expected.account}`)))
      // The cache identifies project, billing account, profile, account and ADC
      // together. A cached failure lets the public usage hook verify that choice
      // without opening a browser or relying on any machine credentials.
      const identity = JSON.stringify([expected.profile, expected.project, expected.billingAccount, expected.account, expected.cloudsdkConfig])
      const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24)
      const file = join(process.env.XDG_CACHE_HOME, "magpie", "gcp-ai", `credits-${digest}.json`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify({ failedAt: new Date().toISOString(), error: `cached settings for ${expected.account}` }))
      const usage = await hooks.auth.usage(async () => ({ ...record, accountId: expected.account }), { options })
      assert.equal(usage.error, `cached settings for ${expected.account}`)
    }
    assert.ok(requests.some((url) => url.includes("/projects/account-project/locations/europe-west1")))
    assert.ok(requests.some((url) => url.includes("/projects/row-project/locations/us-central1")))
  } finally {
    globalThis.fetch = original
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previousCache
    await fixture.close()
  }
})
