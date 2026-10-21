import { execFile, spawn } from "node:child_process"
import { readFile, readdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { assertConsoleSession, expandPath, openBrowser, readConsole, safeGoto, validateProject } from "./browser.mjs"

const execute = promisify(execFile)
const loginTimeout = 10 * 60 * 1000

// gcloud owns refresh tokens and its on-disk token cache. This module reads
// them and, only when no ADC exists at all, has gcloud make one from the Chrome
// sign-in already in progress; it never handles token material itself.
// Never include command output in failures: it can contain credential material.
//
// A Google account's ADC is one file in one config directory, so a second
// account on the same machine gets a directory of its own. Cloud SDK reads
// CLOUDSDK_CONFIG before its default and does not expand "~" in it, so the
// path is made absolute here.
export function cloudsdkConfig(options = {}) {
  const configured = options.cloudsdkConfig || process.env.CLOUDSDK_CONFIG
  return configured ? expandPath(configured) : undefined
}

function gcloudEnvironment(options = {}) {
  const directory = cloudsdkConfig(options)
  return directory ? { ...process.env, CLOUDSDK_CONFIG: directory } : process.env
}

export async function runGcloud(args, options = {}) {
  try {
    const { stdout } = await execute("gcloud", [...args, "--quiet"], {
      timeout: 30000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true, env: gcloudEnvironment(options),
    })
    return stdout.trim()
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("gcloud CLI was not found; install Google Cloud CLI and make it available on PATH")
    if (error.killed) throw new Error("gcloud timed out while reading Google Cloud credentials; retry after checking connectivity")
    const adc = args.includes("application-default")
    throw new Error(`gcloud could not read Google Cloud credentials or configuration. Run ${adc ? "gcloud auth application-default login" : "gcloud auth login"} yourself in a terminal, and check the active gcloud configuration.`)
  }
}

function configured(value) {
  return value && value !== "(unset)" ? value : undefined
}

export function authMode(options = {}) {
  const mode = options.authMode || process.env.VERTEX_GCLOUD_AUTH_MODE || "auto"
  if (!["auto", "gcloud", "adc"].includes(mode)) throw new Error("VERTEX_GCLOUD_AUTH_MODE must be auto, gcloud or adc")
  return mode
}

// Application Default Credentials are what the official Vertex clients use.
// Mirror their lookup: an explicit credentials file first, then gcloud's
// well-known ADC file. Existence alone decides the default mode; a broken file
// still surfaces as a clear ADC error rather than silently switching identity.
//
// An account that named its own config directory is read from there and
// nowhere else: GOOGLE_APPLICATION_CREDENTIALS is a machine-wide setting, and
// letting it win would give every account the same ADC again.
export async function adcFile(options = {}) {
  if (options.cloudsdkConfig) return join(expandPath(options.cloudsdkConfig), "application_default_credentials.json")
  const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (explicit) return expandPath(explicit)
  return join(cloudsdkConfig() ?? join(homedir(), ".config", "gcloud"), "application_default_credentials.json")
}

export async function hasAdc(options = {}, exists = async (path) => { try { await readFile(path); return true } catch { return false } }) {
  return exists(await adcFile(options))
}

// The quota project recorded in ADC is the same hint official clients send as
// x-goog-user-project, so it is a better default than gcloud's active project.
export async function adcQuotaProject(options = {}) {
  try {
    const data = JSON.parse(await readFile(await adcFile(options), "utf8"))
    return typeof data.quota_project_id === "string" ? data.quota_project_id : undefined
  } catch { return undefined }
}

export async function effectiveAuthMode(options = {}) {
  const mode = authMode(options)
  if (mode !== "auto") return mode
  return (await hasAdc(options)) ? "adc" : "gcloud"
}

export function validateAccount(account) {
  if (typeof account !== "string" || !/^[^\s@]+@[^\s@]+$/.test(account) || account.startsWith("-")) throw new Error("Set VERTEX_GCLOUD_ACCOUNT to the intended Google account email")
  return account
}

// An explicit project wins. Otherwise the one the signed-in Chrome is actually
// on comes before anything gcloud remembers: the Console page is the only
// source that names a project the same Google account the cookies belong to
// can open, so the models and the credits cannot drift onto different projects.
export async function resolveProject(options = {}, run = runGcloud, mode) {
  // An account's own project is the one that account reads credits from and
  // bills to; it outranks the machine-wide variables, which every account
  // would otherwise share.
  const project = options.project
    || process.env.GOOGLE_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT
    || options.chromeProject
    || (mode === "adc" ? await adcQuotaProject(options) : undefined)
    || configured(await run(["config", "get-value", "project"], options))
  if (!project) throw new Error("No Google Cloud project is configured. Sign in to Cloud Console in the Chrome profile, or set GOOGLE_VERTEX_PROJECT, GOOGLE_CLOUD_PROJECT or --project.")
  return validateProject(project)
}

export async function resolveAccount(options = {}, run = runGcloud) {
  const account = options.account || process.env.VERTEX_GCLOUD_ACCOUNT || configured(await run(["config", "get-value", "account"], options))
  if (!account) throw new Error("No Google Cloud account is signed in. Run gcloud auth login yourself in a terminal.")
  return validateAccount(account)
}

export async function resolveIdentity(options = {}, run = runGcloud) {
  const mode = await effectiveAuthMode(options)
  // ADC is independent of the active gcloud user. An explicit account in ADC
  // mode is only a Console hint; never mislabel ADC with gcloud's active email.
  const hint = options.account || process.env.VERTEX_GCLOUD_ACCOUNT
  const [project, account] = await Promise.all([
    resolveProject(options, run, mode),
    mode === "gcloud" ? resolveAccount(options, run) : hint ? validateAccount(hint) : undefined,
  ])
  // The config directory travels with the identity: every later gcloud call
  // for this account must read the same ADC it was resolved from.
  const cloudsdkConfig = options.cloudsdkConfig
  return { project, ...(account ? { account } : {}), source: "gcloud", authMode: mode, ...(cloudsdkConfig ? { cloudsdkConfig } : {}) }
}

// ADC records a client id and a quota project, not who signed in, so an ADC
// identity has no email. The token it prints can ask Google that question
// directly; the answer is the same account the token bills to. A failure here
// is not a credential failure: it only leaves the account unnamed.
export async function accountOf(token, request = fetch) {
  try {
    const response = await request("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return undefined
    const body = await response.json()
    return typeof body.email === "string" ? validateAccount(body.email) : undefined
  } catch { return undefined }
}

export function tokenProvider(options = {}, run = runGcloud) {
  let pending
  // print-access-token can return a token near expiry. Do not assume it has a
  // fresh one-hour lifetime; gcloud checks expiry and refreshes on each call.
  // Simultaneous requests still share a single subprocess. The mode is resolved
  // once per call chain so an identity resolved earlier pins it.
  return () => {
    pending ??= (async () => {
      const mode = await effectiveAuthMode(options)
      const args = mode === "adc"
        ? ["auth", "application-default", "print-access-token"]
        : ["auth", "print-access-token", `--account=${await resolveAccount(options, run)}`]
      const token = await run(args, options)
      if (!token || /\s/.test(token)) throw new Error(`gcloud returned an empty or invalid access token; run ${mode === "adc" ? "gcloud auth application-default login" : "gcloud auth login"} yourself in a terminal`)
      return token
    })().finally(() => { pending = undefined })
    return pending
  }
}

// This is only a Chrome Console login. gcloud authentication must already be
// usable, and is verified before opening the browser. No CLI login is invoked.
// gcloud's own browser flow keeps the localhost callback server and the token
// exchange; only the window it would open is taken away, by pointing BROWSER
// at a command that does nothing. The consent page is then opened in the
// Chrome profile that is already signed in for credits, so one approval sets
// up ADC and the Console cookies for the same account. gcloud still writes
// ADC itself: this never handles a refresh token or a client secret.
export async function authorizeAdc(page, options = {}, run = spawn) {
  // The project is handed over as gcloud's own --project, which it writes to
  // ADC as the quota project, so later calls bill the project this plugin
  // serves rather than whatever gcloud last had active. --quiet is left off:
  // it is what suppresses the consent URL that is being read here.
  const project = options.project || process.env.GOOGLE_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT
  const args = ["auth", "application-default", "login"]
  if (project) args.push(`--project=${project}`, `--billing-project=${project}`)
  // gcloud writes ADC before it looks for a quota project, and that lookup
  // needs Cloud Resource Manager. When the API is off it throws after the file
  // is already saved, so the exit code alone would report a failed sign-in
  // that in fact produced usable credentials. What tells the two apart is the
  // file itself: one written after this run began is success either way.
  const file = await adcFile(options)
  const before = (await stat(file).then((s) => s.mtimeMs).catch(() => 0))
  // The account's own directory is where gcloud must write: this is what keeps
  // two Google accounts on one machine from overwriting each other's ADC.
  const child = run("gcloud", args, {
    stdio: ["ignore", "pipe", "pipe"], env: { ...gcloudEnvironment(options), BROWSER: "true" }, windowsHide: true,
  })
  let seen = ""
  let opened
  const failure = (message) => new Error(message)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(failure("Google sign-in did not finish within ten minutes; run gcloud auth application-default login yourself in a terminal")) }, loginTimeout)
    timer.unref?.()
    const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve() }
    const scan = (chunk) => {
      seen += String(chunk)
      if (opened) return
      // gcloud ends the URL with a newline: a match followed by whitespace is
      // the whole address, while a chunk boundary is not.
      const found = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?\S+(?=\s)/.exec(seen)
      if (!found) return
      // gcloud's address is opened exactly as it printed it. Its query is
      // Google's own OAuth request, and adding to it — an authuser hint, say —
      // makes Google answer 400 instead of asking for consent.
      // The consent page is the only thing opened here; the code goes to
      // gcloud's localhost server, never through this process. It is its own
      // tab so the Console page underneath is left where it was.
      opened = (async () => {
        const tab = await page.context?.().newPage().catch(() => undefined) ?? page
        await tab.goto(found[0].trim(), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {})
        return tab
      })()
    }
    child.stderr?.on("data", scan)
    child.stdout?.on("data", scan)
    child.once("error", (error) => finish(failure(error.code === "ENOENT" ? "gcloud CLI was not found; installing it lets this plugin set up ADC from the Chrome sign-in" : "gcloud could not be started to set up ADC")))
    // The window may be gone by the time the tab would close; that is not a
    // reason to report a failed sign-in.
    child.once("exit", async (code) => {
      if (code !== 0) {
        const written = await stat(file).then((s) => s.mtimeMs > before).catch(() => false)
        // A new ADC file means the sign-in worked; only the quota-project probe
        // after it failed, which this plugin does not depend on.
        if (!written) return finish(failure("gcloud could not set up ADC from the Chrome sign-in; run gcloud auth application-default login yourself in a terminal"))
      }
      // The consent tab has done its job: it is closed rather than left open on
      // a callback page that no longer means anything.
      const tab = await opened?.catch(() => undefined)
      if (tab && tab !== page) await tab.close().catch(() => {})
      finish()
    })
  })
  return true
}

// One Google account's ADC is one file, so a second account needs a directory
// of its own. The default is only taken by an account whose token it already
// answers for: otherwise a new account would silently sign with the old one's
// credentials, which is exactly the mix-up this keeps apart.
export function adcSlug(account) {
  return account.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
}

export function adcDirectoryFor(account, root = join(homedir(), ".config")) {
  return join(root, `gcp-adc-${adcSlug(account)}`)
}

const ADC_DIRS = "gcp-adc-"

// The Google accounts this machine has already signed in to Vertex with. Every
// account after the first keeps its own ADC directory, named after it, so the
// directories themselves are the list; the first one keeps gcloud's default
// directory, and only its ADC can name its owner. A later sign-in compares the
// account it was given against this to tell an account being added from one
// already here.
export async function knownAccounts(options = {}) {
  const root = options.adcRoot ? expandPath(options.adcRoot) : join(homedir(), ".config")
  const known = new Set((await readdir(root).catch(() => []))
    .filter((name) => name.startsWith(ADC_DIRS))
    .map((name) => name.slice(ADC_DIRS.length)))
  if (!options.cloudsdkConfig && await hasAdc()) {
    const owner = await (options.ownerOf ?? adcOwner)()
    if (owner) known.add(adcSlug(owner))
  }
  return known
}

async function adcOwner(directory) {
  try {
    return await accountOf(await tokenProvider({ authMode: "adc", ...(directory ? { cloudsdkConfig: directory } : {}) })())
  } catch { return undefined }
}

// The directory this account's ADC belongs in, and whether it exists yet.
// undefined means gcloud's default, which is left for the first account so a
// machine that already signed in once keeps working exactly as before.
export async function resolveAdcDirectory(options = {}) {
  if (options.cloudsdkConfig) {
    const directory = expandPath(options.cloudsdkConfig)
    return { directory, exists: await hasAdc({ cloudsdkConfig: directory }) }
  }
  const account = options.account
  if (!account) return { directory: undefined, exists: await hasAdc() }
  const own = adcDirectoryFor(account, options.adcRoot ? expandPath(options.adcRoot) : undefined)
  if (await hasAdc({ cloudsdkConfig: own })) return { directory: own, exists: true }
  if (await hasAdc() && (await adcOwner()) === account) return { directory: undefined, exists: true }
  return { directory: own, exists: false }
}

// Google's own "add another account" page. Its `continue` sends the browser
// back to the Console once the account is added, so the Console the browser
// lands on is already signed in as the account just added — that is where the
// account for this sign-in is read.
export const ADD_ACCOUNT_URL = "https://accounts.google.com/AddSession?hl=en&continue=https%3A%2F%2Fconsole.cloud.google.com%2F"

const consoleUrl = (account, project) => "https://console.cloud.google.com/?hl=en"
  + (project ? `&project=${encodeURIComponent(project)}` : "")
  + (account ? `&authuser=${encodeURIComponent(account)}` : "")

// An error that ends the sign-in instead of merely leaving it without a
// Console: the person added no account, or added one that is already here.
// There is nothing to save, and the message is what they are shown.
const stopped = (message) => Object.assign(new Error(message), { stopped: true })

// Which Google account this sign-in serves.
//
// The first sign-in is the account Chrome already uses: the Console is opened
// and read exactly as it always has been. A sign-in on a machine that already
// has an account is a request to add one, so Google's own add-account page is
// opened directly — there is no address to type and no account to pick first.
// Its `continue` brings the browser back to the Console as the account just
// added, and that Console is read for the account and the project.
//
// The only comparison made is with the accounts this machine already signed in
// with: coming back as one of those adds nothing, and the sign-in says so
// instead of saving a second copy of the same account.
//
// A named account is the row's own instruction and is taken as such: the
// Console is asked for it by address, and the add-account page only opens when
// Chrome is on a different account.
async function chooseAccount(page, options, limit, known) {
  const named = options.account
  let shown
  if (named || !known.size) {
    await safeGoto(page, consoleUrl(named))
    await assertConsoleSession(page, { timeout: limit })
    shown = await readConsole(page, { timeout: 30000 }).catch(() => ({}))
    if (!named || shown.account === named) return shown
  }
  await safeGoto(page, ADD_ACCOUNT_URL)
  let added
  try {
    await assertConsoleSession(page, { timeout: limit })
    added = await readConsole(page, { timeout: 30000 }).catch(() => ({}))
  } catch {
    throw stopped(named && shown?.account
      ? `Chrome is signed in as ${shown.account}, not ${named}: sign in to ${named} in the Chrome window that opened, then start the sign-in again`
      : `No Google account was added: sign in to ${named ?? "the account this row should serve"} in the Chrome window that opened, then start the sign-in again`)
  }
  if (named) {
    if (added.account === named) return added
    throw stopped(added.account
      ? `Chrome is signed in as ${added.account}, not ${named}: sign in to ${named} in the Chrome window that opened, then start the sign-in again`
      : `No Google account was added: sign in to ${named} in the Chrome window that opened, then start the sign-in again`)
  }
  if (added.account && known.has(adcSlug(added.account))) {
    throw stopped(`${added.account} is already signed in, so no account was added. Add a different Google account in the Chrome window that opened, then start the sign-in again`)
  }
  return added
}

export async function startLogin(options = {}, open = openBrowser) {
  // A sign-in the user asks gcloud for explicitly is left to them.
  const wanted = authMode(options)
  // How long a person has to sign in. It is the same ten minutes everywhere
  // unless a caller shortens it.
  const limit = Number(options.loginTimeout) > 0 ? Number(options.loginTimeout) : loginTimeout
  // One ADC directory named by the row is one account's credentials: there is
  // no second account to go looking for there, so that machine signs in exactly
  // as it always has. Naming an account overrides it — that account is the one
  // the directory must hold.
  const pinned = Boolean(options.cloudsdkConfig && !options.account)
  const browser = await open({ profile: options.profile, headless: false })
  let closed = false
  // The sign-in is what the window was opened for. Once it is over, the whole
  // window closes: the profile keeps its cookies on disk, so the next credit
  // read opens the same signed-in profile without leaving a Chrome behind.
  const close = async () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    await browser.close()
  }
  const timer = setTimeout(() => { void close().catch(() => {}) }, limit)
  timer.unref?.()
  const result = (async () => {
    // Chrome is where the Google sign-in happens, and the account it is signed
    // in to is the one the Console cookies belong to. Reading that account and
    // its project first is also what pins the gcloud consent page to the same
    // account, so one approval serves both the token and the credits.
    let chromeError
    let chromeProject
    let chromeAccount
    // The accounts this machine signed in with before this run. It is read
    // before anything is written, so the account just added — and the ADC
    // directory that will name it — is never mistaken for one already here.
    let registered
    try {
      if (pinned) {
        await safeGoto(browser.page, consoleUrl(options.account))
        await assertConsoleSession(browser.page, { timeout: limit })
        // Both come from this one page: the account is in the same payload that
        // names the project, so nothing else is loaded to learn who is signed in,
        // and waiting for them together costs one page load rather than two.
        ;({ project: chromeProject, account: chromeAccount } =
          await readConsole(browser.page, { timeout: 30000 }).catch(() => ({ project: undefined, account: undefined })))
      } else {
        // Which account this sign-in serves is decided in the Chrome window: the
        // one already there for a first sign-in, and the one added for a later
        // one. The ADC directories this machine keeps are what tell an account
        // being added from one that is already signed in.
        registered = await knownAccounts(options)
        ;({ project: chromeProject, account: chromeAccount } =
          await chooseAccount(browser.page, options, limit, registered))
      }
    } catch (error) {
      // Added nothing, or added an account that was already here: there is no
      // account to save, and saying so is more use than an unnamed identity.
      if (error.stopped) throw error
      chromeError = error
    }
    const account = chromeAccount ?? options.account
    // ADC is made inside the Chrome window that is already signed in, in the
    // directory that belongs to this account alone. Who that is has to be
    // known first: writing credentials for an account the Console never showed
    // is exactly the mix-up this keeps apart, so a sign-in that could not name
    // its account writes none.
    const identifiable = Boolean(chromeAccount || !chromeError)
    const adc = wanted === "gcloud" || !identifiable ? { directory: undefined, exists: true } : await resolveAdcDirectory({ ...options, account })
    if (wanted !== "gcloud" && identifiable && !adc.exists) {
      await authorizeAdc(browser.page, {
        ...options, account, project: chromeProject ?? options.project,
        ...(adc.directory ? { cloudsdkConfig: adc.directory } : {}),
      })
      // The second half of the same rule: an account that is already signed in
      // is not added again. The consent page can come back as the account that
      // was already here, and gcloud has then written its credentials where the
      // new account's belong; the token says who it is, and that answer is
      // checked against the accounts this machine had before the run. What this
      // run wrote is removed — the file is new, since no ADC was there — and
      // nothing is recorded. Credentials are never moved between directories.
      const written = adc.directory ? { authMode: "adc", cloudsdkConfig: adc.directory } : { authMode: "adc" }
      const approved = await accountOf(await tokenProvider(written)().catch(() => undefined))
      if (approved && approved !== account) {
        if (adc.directory) await rm(adc.directory, { recursive: true, force: true })
        registered ??= await knownAccounts(options)
        throw stopped(registered.has(adcSlug(approved))
          ? `${approved} is already signed in, and the consent page approved that account rather than ${account}; nothing was saved. Sign in again and choose ${account} on Google's consent page.`
          : `The consent page approved ${approved}, not ${account}; nothing was saved. Sign in again and choose ${account} on Google's consent page.`)
      }
    }
    const found = await resolveIdentity({
      ...options,
      ...(account ? { account } : {}),
      ...(chromeProject ? { chromeProject } : {}),
      ...(adc.directory ? { cloudsdkConfig: adc.directory } : {}),
    })
    const token = await tokenProvider(found)()
    // The host shows the account label from what a sign-in records. The Chrome
    // profile names it directly, and a token's userinfo is asked only when
    // that failed: it costs a round trip and describes the gcloud identity
    // rather than the cookies the credits are read with.
    const owner = found.account ?? (found.authMode === "adc" && !chromeError ? await accountOf(token) : undefined)
    const identity = owner ? { ...found, account: owner } : found
    // A Console that never became usable does not invalidate the tokens that
    // were just verified; it only leaves the credits unreadable for now.
    if (chromeError) return { ...identity, creditsSession: "unavailable", warning: chromeError.message }
    // The page that answered the questions above is already this project's
    // Console, so it is only revisited when the account was named elsewhere.
    if (chromeProject !== identity.project || chromeAccount !== identity.account) {
      try { await safeGoto(browser.page, `https://console.cloud.google.com/?project=${encodeURIComponent(identity.project)}${identity.account ? `&authuser=${encodeURIComponent(identity.account)}` : ""}&hl=en`) } catch {}
    }
    try {
      await assertConsoleSession(browser.page, { timeout: limit })
      return { ...identity, creditsSession: "ready" }
    } catch (error) {
      return { ...identity, creditsSession: "unavailable", warning: error.message }
    }
  })()
  // Host callbacks may be invoked later; retain any cleanup rejection until
  // the callback awaits it without emitting an unhandled-rejection event.
  const settled = result.catch((error) => ({ creditsSession: "unavailable", warning: error.message }))
  settled.finally(() => { void close().catch(() => {}) })
  return { result: settled, close, terminate: close }
}
