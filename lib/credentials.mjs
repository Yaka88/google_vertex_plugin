import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { promisify } from "node:util"
import { configRoot, expandPath, home, openSignInWindow, validateProject } from "./browser.mjs"
import { take } from "./lock.mjs"

const execute = promisify(execFile)
const loginTimeout = 10 * 60 * 1000

// gcloud owns the ADC file and creates it during sign-in. Its authorized-user
// credentials can also refresh an access token directly, without a subprocess.
// Never include command output or credential material in failures.
//
// A Google account's ADC is one file in one config directory, so a second
// account on the same machine gets a directory of its own. Cloud SDK reads
// CLOUDSDK_CONFIG before its default and does not expand "~" in it, so the
// path is made absolute here.
//
// Only a directory this plugin resolved for an account is ever used: the
// machine-wide CLOUDSDK_CONFIG variable is not read at all. One variable would
// point every account at one ADC, and a sign-in there would write over
// credentials the plugin never made.
export function cloudsdkConfig(options = {}) {
  const configured = options.cloudsdkConfig
  return configured ? expandPath(configured) : undefined
}

// gcloud reads CLOUDSDK_CONFIG before its default. With no directory of this
// plugin's own, the variable is taken away rather than passed through: the ADC
// read here is gcloud's default, and a machine-wide variable pointing somewhere
// else would make gcloud print a token from a directory this plugin never read.
function gcloudEnvironment(options = {}) {
  const directory = cloudsdkConfig(options)
  if (directory) return { ...process.env, CLOUDSDK_CONFIG: directory }
  if (!("CLOUDSDK_CONFIG" in process.env)) return process.env
  const env = { ...process.env }
  delete env.CLOUDSDK_CONFIG
  return env
}

// gcloud on Windows is gcloud.cmd, a batch file. execFile and spawn without a
// shell run it as a binary, which the OS refuses with EINVAL, so every call
// there goes through cmd.exe. The arguments are fixed strings this module built
// (never anything a person typed), and cmd is only asked to start one program
// by name, so there is nothing for a shell to interpolate: the command name and
// each argument are quoted, and a quote inside one would end the quoting, so an
// argument that could not be carried is refused rather than handed over.
const WINDOWS = process.platform === "win32"

// The command line for cmd.exe. The program and every argument are quoted,
// and the whole line is quoted once more: cmd's /s takes the outer pair off,
// and what is left is the program and its arguments as separate tokens.
export function windowsCommand(program, args) {
  const quoted = [program, ...args].map((value) => `"${value}"`).join(" ")
  return ["/d", "/s", "/c", `"${quoted}"`]
}

// Where gcloud.cmd is, as the command line has to name it.
//
// The program is named by its own path, not by the name it happens to have on
// PATH. A batch file takes the Cloud SDK root from the directory it was
// started in (%~dp0); started by name, it has no directory of its own there,
// and that is the caller's, so gcloud looks for its own library under the
// caller's directory and fails to start, with nothing in its output to say
// why.
//
// CLOUDSDK_ROOT_DIR is the variable the Cloud SDK itself sets, so it names the
// same installation the SDK reports. A PATH entry may be quoted
// ("C:\Program Files\..."), and the quotes are not part of the directory. The
// environment is an argument so that this can be read on any platform.
export function gcloudProgram(env = process.env) {
  const root = env.CLOUDSDK_ROOT_DIR
  if (root) {
    const candidate = join(root, "bin", "gcloud.cmd")
    if (existsSync(candidate)) return candidate
  }
  for (const entry of (env.PATH || "").split(delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1")
    if (!dir) continue
    const candidate = join(dir, "gcloud.cmd")
    if (existsSync(candidate)) return candidate
  }
  return "gcloud"
}

export function command(name, args) {
  if (!WINDOWS) return { file: name, args, options: {} }
  for (const value of [name, ...args]) {
    if (/["\r\n]/.test(value)) throw new Error(`Cannot run ${name} on Windows: an argument contains a quote or a line break`)
  }
  const program = name.toLowerCase() === "gcloud" ? gcloudProgram() : name
  return { file: process.env.ComSpec || "cmd.exe", args: windowsCommand(program, args), options: { windowsVerbatimArguments: true } }
}

export async function runGcloud(args, options = {}) {
  try {
    const started = command("gcloud", [...args, "--quiet"])
    const { stdout } = await execute(started.file, started.args, {
      timeout: 30000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true, env: gcloudEnvironment(options), ...started.options,
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
  // gcloud's default directory, as gcloudEnvironment tells gcloud: a
  // machine-wide CLOUDSDK_CONFIG is not read here either.
  return join(gcloudDefaultDirectory(), "application_default_credentials.json")
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
    || options.chromeProject
    || process.env.GOOGLE_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT
    // ADC's quota_project_id selects quota billing, not the project whose
    // Vertex resources this account should use. It cannot fill this gap.
    || configured(await run(["config", "get-value", "project"], options))
  if (!project) throw Object.assign(new Error("No Google Cloud project is configured. Set the project selected in Cloud Console using GOOGLE_VERTEX_PROJECT, GOOGLE_CLOUD_PROJECT or --project."), { code: "VERTEX_PROJECT_REQUIRED" })
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
export async function identityOf(token, request = fetch) {
  try {
    const response = await request("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return undefined
    const body = await response.json()
    // `email` is the display label; `sub` is the stable identity used to
    // reject a different Google account after an email rename or replacement.
    // Keep a valid subject even when Google's response has no usable email:
    // a successful response that names another account must not look offline.
    const subject = typeof body?.sub === "string" && body.sub ? body.sub : undefined
    if (typeof body?.email !== "string") return subject ? { subject } : {}
    try {
      return { account: validateAccount(body.email), ...(subject ? { subject } : {}) }
    } catch {
      return subject ? { subject } : {}
    }
  } catch { return undefined }
}

export async function accountOf(token, request = fetch) {
  return (await identityOf(token, request))?.account
}

// Which projects the signed-in account could actually serve. Cloud Resource
// Manager lists the projects that are alive; Service Usage says whether Vertex
// AI is turned on in each. Billing is deliberately not consulted: whether a
// project can pay is the account owner's decision, not a reason to hide it.
//
// This runs inside a sign-in, so it never throws: no list, no permission or no
// network only means there is nothing to offer, and the sign-in can then say
// so instead of failing as a credential error. Neither the token nor a
// response body is ever put in an error or logged.
const PROJECT_CONCURRENCY = 6
const PROJECT_TIMEOUT = 15000

async function usableProjects(token, request = fetch) {
  const response = await request("https://cloudresourcemanager.googleapis.com/v1/projects", {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(PROJECT_TIMEOUT),
  })
  if (!response.ok) throw new Error(`Cloud Resource Manager returned ${response.status}`)
  const body = await response.json()
  const active = Array.isArray(body?.projects)
    ? body.projects.filter((project) => project && project.lifecycleState === "ACTIVE" && typeof project.projectId === "string" && project.projectId)
    : []
  const usable = new Array(active.length)
  let next = 0
  // A small pool: a person may have dozens of projects, and asking for all of
  // them at once is how a sign-in gets rate limited by its own probe.
  const worker = async () => {
    while (next < active.length) {
      const index = next++
      const project = active[index]
      const enabled = await request(
        `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(project.projectId)}/services/aiplatform.googleapis.com`,
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(PROJECT_TIMEOUT) },
      )
        .then((probe) => (probe.ok ? probe.json() : undefined))
        .then((service) => service?.state === "ENABLED")
        .catch(() => false)
      usable[index] = {
        projectId: project.projectId,
        name: typeof project.name === "string" && project.name ? project.name : project.projectId,
        vertexEnabled: enabled === true,
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROJECT_CONCURRENCY, active.length) }, worker))
  return usable
}

export async function listUsableProjects(token, request = fetch) {
  if (typeof token !== "string" || !token) return { projects: [], error: "No access token was available" }
  try {
    return { projects: await usableProjects(token, request), error: undefined }
  } catch (error) {
    return { projects: [], error: error?.message ?? "The project list could not be read" }
  }
}

// All callers for an identity share a cache and in-flight refresh, so a
// background endpoint probe and a real request do not refresh separately.
// The cache is keyed by the fetch function it was given, so a fetch the caller
// has dropped can be collected and the tokens it fetched go with it. The
// default fetch is one function, and real callers still share one cache per
// identity through it. `run` stays in the inner key so two injected runners
// never serve each other's token.
const tokenCaches = new WeakMap()
const callerIds = new WeakMap()
let nextCallerId = 0
function callerId(fn) {
  if (!callerIds.has(fn)) callerIds.set(fn, ++nextCallerId)
  return callerIds.get(fn)
}

function tokenState(options, run, request) {
  let states = tokenCaches.get(request)
  if (!states) tokenCaches.set(request, states = new Map())
  const key = JSON.stringify([
    cloudsdkConfig(options) || "", options.project || "", options.account || "",
    options.authMode || process.env.VERTEX_GCLOUD_AUTH_MODE || "auto",
    callerId(run),
  ])
  let state = states.get(key)
  // The first provider for an identity supplies its injected run and request.
  if (!state) states.set(key, state = { pending: undefined, cached: undefined, refreshing: undefined, run, request })
  return state
}

export function tokenProvider(options = {}, run = runGcloud, request = fetch) {
  const state = tokenState(options, run, request)
  // Only the OAuth response supplies an expiry; gcloud can print a token near
  // expiry, so its result is shared concurrently but never cached here. Resolve
  // auto mode on every call before using the cache, since ADC can be removed.
  const getToken = async () => {
    const mode = await effectiveAuthMode(options)
    if (mode === "adc" && state.cached && Date.now() < state.cached.until) return state.cached.token
    if (!state.pending || state.pending.mode !== mode) {
      const promise = (async () => {
        if (mode === "adc") {
          try {
            const credentials = JSON.parse(await readFile(await adcFile(options), "utf8"))
            const { client_id, client_secret, refresh_token } = credentials
            if (credentials.type !== "authorized_user" || ![client_id, client_secret, refresh_token].every((value) => typeof value === "string" && value)) throw new Error()
            const started = Date.now()
            const response = await state.request("https://oauth2.googleapis.com/token", {
              method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: "refresh_token" }),
              signal: AbortSignal.timeout(10000), redirect: "error",
            })
            if (!response.ok) throw new Error()
            const body = await response.json()
            const lifetime = body.expires_in
            if (typeof body.access_token !== "string" || !body.access_token || /\s/.test(body.access_token)) throw new Error()
            // An invalidated refresh must not put its old token back in the cache.
            if (typeof lifetime === "number" && Number.isFinite(lifetime) && lifetime > 0 && state.pending?.promise === promise) {
              state.cached = { token: body.access_token, until: started + Math.max(0, lifetime - 60) * 1000 }
            }
            return body.access_token
          } catch { /* gcloud handles other ADC types and reports credential failures. */ }
        }
        const args = mode === "adc"
          ? ["auth", "application-default", "print-access-token"]
          : ["auth", "print-access-token", `--account=${await resolveAccount(options, state.run)}`]
        const token = await state.run(args, options)
        if (!token || /\s/.test(token)) throw new Error(`gcloud returned an empty or invalid access token; run ${mode === "adc" ? "gcloud auth application-default login" : "gcloud auth login"} yourself in a terminal`)
        return token
      })()
      const current = { mode, promise }
      state.pending = current
      void promise.finally(() => { if (state.pending === current) state.pending = undefined }).catch(() => {})
    }
    return state.pending.promise
  }
  getToken.invalidate = () => {
    state.cached = undefined
    state.pending = undefined
  }
  // A 401 drops the cached token and fetches again. Concurrent 401s share this
  // promise. invalidate() and then getToken() does not: the second invalidate
  // clears the in-flight entry the first refresh just started.
  getToken.refresh = () => {
    if (state.refreshing) return state.refreshing
    state.cached = undefined
    state.pending = undefined
    const refreshing = getToken().finally(() => {
      if (state.refreshing === refreshing) state.refreshing = undefined
    })
    state.refreshing = refreshing
    return refreshing
  }
  return getToken
}

// This is only a Chrome Console login. gcloud authentication must already be
// usable, and is verified before opening the browser. No CLI login is invoked.
// gcloud's own browser flow keeps the localhost callback server and the token
// exchange; only the window it would open is taken away, by pointing BROWSER
// at a command that does nothing. The consent page is then opened in the
// Chrome profile that is already signed in for credits, so one approval sets
// up ADC and the Console cookies for the same account. gcloud still writes
// ADC itself: this never handles a refresh token or a client secret.
//
// What it returns is what the caller may undo: `file` exists only when this
// run is the one that made it, and only that file is ever removed again.
// gcloud's consent flow, started but not yet shown.
//
// What comes back is the address gcloud wants approved and a promise that
// settles when gcloud is done with it. That order matters: the address has to
// exist before a window opens, because the window is opened *on it* — one
// window, one tab, and the person signs in and approves in the same place.
// Waiting for gcloud's exit is also how the sign-in knows it is over; there is
// nothing to poll and nothing to guess at.
export async function beginAdcLogin(options = {}, run = spawn) {
  // The project is handed over as gcloud's own --project, which it writes to
  // ADC as the quota project, so later calls bill the project this plugin
  // serves rather than whatever gcloud last had active. --quiet is left off:
  // it is what suppresses the consent URL that is read here.
  const project = options.project || process.env.GOOGLE_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT
  const args = ["auth", "application-default", "login"]
  if (project) args.push(`--project=${project}`, `--billing-project=${project}`)
  // gcloud writes ADC before it looks for a quota project, and that lookup
  // needs Cloud Resource Manager. When the API is off it throws after the file
  // is already saved, so the exit code alone would report a failed sign-in
  // that in fact produced usable credentials. What tells the two apart is the
  // file itself: one written after this run began is success either way.
  const file = await adcFile(options)
  const before = await stat(file).then((s) => s.mtimeMs, () => 0)
  // BROWSER is neutralised so gcloud does not open a window of its own: the
  // person approves in the one window this plugin opened, and a second browser
  // would be both confusing and, being unapproved by them, unwanted.
  //
  // gcloud hands BROWSER to Python's webbrowser, which reads the value as a
  // command line with %s standing for the address. `true` is that command on
  // macOS and Linux and does not exist on Windows, where cmd.exe's own `rem`
  // is the no-op — spelled out with /c so it is one command, not a shell.
  const started = command("gcloud", args)
  const child = run(started.file, started.args, {
    stdio: ["ignore", "pipe", "pipe"], env: { ...gcloudEnvironment(options), BROWSER: WINDOWS ? "cmd /c rem %s" : "true" }, windowsHide: true, ...started.options,
  })
  let seen = ""
  let announce
  const url = new Promise((resolve) => { announce = resolve })
  // A gcloud that never prints an address (no network, no CLI) must not leave
  // the caller waiting on a window that can never open.
  const timer = setTimeout(() => announce(undefined), 60000)
  timer.unref?.()
  const scan = (chunk) => {
    if (seen.includes("\u0000")) return
    seen += String(chunk)
    // gcloud ends the URL with a newline: a match followed by whitespace is the
    // whole address, while a chunk boundary is not.
    const found = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?\S+(?=\s)/.exec(seen)
    if (!found) return
    seen += "\u0000" // one address, announced once
    clearTimeout(timer)
    announce(found[0].trim())
  }
  child.stderr?.on("data", scan)
  child.stdout?.on("data", scan)
  const done = new Promise((resolve, reject) => {
    const expiry = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Google sign-in did not finish within ten minutes; run gcloud auth application-default login yourself in a terminal"))
    }, loginTimeout)
    expiry.unref?.()
    const finish = (error) => { clearTimeout(expiry); clearTimeout(timer); announce(undefined); error ? reject(error) : resolve() }
    child.once("error", (error) => finish(new Error(error.code === "ENOENT"
      ? "gcloud CLI was not found; installing it lets this plugin set up ADC from the Chrome sign-in"
      : "gcloud could not be started to set up ADC")))
    child.once("exit", async (code) => {
      if (code !== 0) {
        const written = await stat(file).then((s) => s.mtimeMs > before).catch(() => false)
        // A new ADC file means the sign-in worked; only the quota-project probe
        // after it failed, which this plugin does not depend on.
        if (!written) return finish(new Error("gcloud could not set up ADC from the Chrome sign-in; run gcloud auth application-default login yourself in a terminal"))
      }
      finish()
    })
  })
  // The caller owns the rejection; this keeps a process that never awaits it
  // from crashing on an unhandled one.
  done.catch(() => {})
  return { url, done, child, file: before ? undefined : file }
}

// One Google account's ADC is one file, and the plugin keeps its own for every
// account it serves. gcloud's default directory (~/.config/gcloud) is the
// machine's: it is what every other Google client library on the machine reads,
// so a sign-in here writes nothing there. Each account's ADC goes to a
// directory of its own under the plugin's own root instead, which is also what
// lets two Google accounts coexist and keeps the plugin's quota project from
// leaking into anyone else's tooling.
export function adcSlug(account) {
  return account.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
}

// Where the plugin keeps per-account state: ADC directories named by account,
// and the profile lock that says which account a Chrome profile last served.
export function adcRoot() {
  return join(configRoot(), "gcp-ai")
}

export function adcDirectoryFor(account, root = adcRoot()) {
  return join(root, `adc-${adcSlug(account)}`)
}

// A slug is readable, not unique: a.b@x.com and a-b@x.com both become
// a-b-x-com, and one directory holding the other account's ADC is a sign-in
// refused for an account that was never here. So a slug another account
// already owns gets a short hash of the full address appended; the first
// account keeps the readable name.
const disambiguated = (account, root) => join(root, `adc-${adcSlug(account)}-${createHash("sha256").update(account.toLowerCase()).digest("hex").slice(0, 6)}`)
const subjectDirectory = (account, subject, root) => join(root, `adc-${adcSlug(account)}-sub-${createHash("sha256").update(subject).digest("hex")}`)
const accountKeyFor = (account, subject) => `${account}#${createHash("sha256").update(subject).digest("hex").slice(0, 12)}`

// Where this account's own ADC lives, whether or not it exists yet. The
// readable directory is read first, so the check costs nothing for the usual
// case; a hash-suffixed one is only ever consulted after it.
export async function adcDirectoryOwnedBy(account, root = adcRoot()) {
  const plain = adcDirectoryFor(account, root)
  if (await hasAdc({ cloudsdkConfig: plain })) {
    // Offline is not evidence of another owner: only a definite answer moves
    // the account to a directory of its own.
    const owner = await adcOwner({ cloudsdkConfig: plain }).catch(() => undefined)
    if (!owner || owner.toLowerCase() === account.toLowerCase()) return plain
    return disambiguated(account, root)
  }
  const hashed = disambiguated(account, root)
  return (await hasAdc({ cloudsdkConfig: hashed })) ? hashed : plain
}

// The directory a sign-in may write this account's ADC into: the readable one
// unless another account already owns it, in which case the hash-suffixed one.
export async function adcDirectoryToCreate(account, root = adcRoot()) {
  const plain = adcDirectoryFor(account, root)
  const exists = await stat(plain).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error })
  if (!exists) return plain
  const owner = await adcOwner({ cloudsdkConfig: plain }).catch(() => undefined)
  if (!owner || owner.toLowerCase() === account.toLowerCase()) return plain
  return disambiguated(account, root)
}

// gcloud's own default directory. ADC written here is read by every Google
// client library on the machine, so this plugin never writes to it: it is only
// ever read, when a machine already signed in that way before the plugin
// existed. A configured CLOUDSDK_CONFIG that points here is the same directory
// under another name.
export function gcloudDefaultDirectory() {
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "gcloud")
  return join(home(), ".config", "gcloud")
}

export const isGcloudDefault = (directory) => expandPath(directory) === expandPath(gcloudDefaultDirectory())

const ADC_DIRS = "adc-"
// 0.1.1 staged unnamed sign-ins in mkdtemp(join(root, "adc-pending-")), which
// appends six alphanumeric characters with no "-". Every validated email has
// "@" and therefore produces a "-" after the local-part in adcSlug(account).
const LEGACY_PENDING_ADC = /^adc-pending-[0-9A-Za-z]{6}$/

// Inventory of managed ADC directories, used to choose the first/add-account
// consent page. These directory labels are NOT Google account identities.
// Duplicate detection resolves each credential's current subject separately.
//
// The machine's own gcloud ADC is deliberately not part of this set. It is a
// different credential in a different place, read by every other Google client
// on the machine; signing in here adds the plugin's own ADC even for an account
// that file already belongs to. Only what this plugin filed counts.
export async function knownAccounts(options = {}) {
  const root = options.adcRoot ? expandPath(options.adcRoot) : adcRoot()
  const known = new Set()
  const names = await readdir(root).catch((error) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  for (const name of names) {
    if (!name.startsWith(ADC_DIRS) || LEGACY_PENDING_ADC.test(name)) continue
    // Staging directories use a separate hidden prefix, so a legitimate
    // account whose email starts with "pending-" remains discoverable.
    const present = await lstat(join(root, name, "application_default_credentials.json")).then(() => true, (error) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false
      throw error
    })
    if (present) known.add(name.slice(ADC_DIRS.length))
  }
  return known
}

// Who an ADC belongs to. ADC records a client id and a quota project, not an
// email, so the only answer comes from the token gcloud prints for it.
async function adcOwner(options = {}) {
  try {
    return await accountOf(await tokenProvider({ authMode: "adc", ...options })())
  } catch { return undefined }
}

// Legacy directories keep their old email names after a rename. Resolve every
// managed ADC rather than deriving its location from the current email.
// An unreadable identity is unknown, never proof of a distinct account.
async function registeredSubject(subject, root) {
  let unknown = false
  for (const name of await knownAccounts({ adcRoot: root })) {
    const directory = join(root, `${ADC_DIRS}${name}`)
    const entry = await lstat(directory).catch(() => undefined)
    if (!entry?.isDirectory() || entry.isSymbolicLink()
      || dirname(await realpath(directory)) !== await realpath(root)) {
      unknown = true
      continue
    }
    const owner = await tokenProvider({ authMode: "adc", cloudsdkConfig: directory })()
      .then(identityOf).catch(() => undefined)
    if (owner?.subject === subject) return directory
    if (!owner?.subject) unknown = true
  }
  if (unknown) throw stopped("An existing ADC's Google subject could not be confirmed; no new account was added. Restore access to that credential or remove the stale account explicitly, then retry")
}

async function registeredEmail(account, root) {
  for (const name of await knownAccounts({ adcRoot: root })) {
    const directory = join(root, `${ADC_DIRS}${name}`)
    const owner = await tokenProvider({ authMode: "adc", cloudsdkConfig: directory })()
      .then(identityOf).catch(() => undefined)
    if (owner?.account?.toLowerCase() === account.toLowerCase()) return true
  }
  return false
}

// Names only allocate storage. A collision does not mean the same account:
// the subject comparison must have finished before choosing a free directory.
async function availableAdcDirectory(account, subject, root) {
  for (const directory of [adcDirectoryFor(account, root), disambiguated(account, root), subjectDirectory(account, subject, root)]) {
    const occupied = await lstat(directory).then(() => true, (error) => {
      if (error.code === "ENOENT") return false
      throw error
    })
    if (!occupied) return directory
  }
  throw stopped("The ADC storage paths are occupied; existing files were kept and no new account was added")
}

// Google's own "add another account" page. Console is the fallback destination
// for a session without ADC consent; signInUrl replaces that destination with
// gcloud's consent URL whenever this run is creating credentials.
export const ADD_ACCOUNT_URL = "https://accounts.google.com/AddSession?hl=en&continue=https%3A%2F%2Fconsole.cloud.google.com%2F"

const consoleUrl = (account, project) => "https://console.cloud.google.com/?hl=en"
  + (project ? `&project=${encodeURIComponent(project)}` : "")
  + (account ? `&authuser=${encodeURIComponent(account)}` : "")

// An error that ends the sign-in instead of merely leaving it without a
// Console: the person added no account, or added one that is already here.
// There is nothing to save, and the message is what they are shown.
const stopped = (message) => Object.assign(new Error(message), { stopped: true })

// The project a new ADC will serve. Magpie cannot ask the person anything once
// authorize() has started, and the project list only exists after consent, so
// there is nowhere to ask and nothing to ask with: the first project the
// account already has Vertex AI turned on in is taken as it is. The order is
// Cloud Resource Manager's, which keeps the answer stable between two sign-ins
// of the same account.
//
// An explicit project wins and needs no list. `picked` tells the caller the
// sign-in chose this one itself, which is what the editor's field then shows.
function chooseProject({ projects, who, options = {} }) {
  const explicit = options.project || process.env.GOOGLE_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT
  if (explicit) {
    const project = validateProject(explicit)
    // A configured project needs no list, but a list that was read may say the
    // API is off. Refusing then is the same clear verdict as the empty case;
    // a project the list does not mention is not second-guessed.
    const listed = (projects ?? []).find((candidate) => candidate.projectId === project)
    if (listed && listed.vertexEnabled !== true) {
      throw stopped(`${project} does not have Vertex AI enabled, so nothing was registered. Enable the Vertex AI API (aiplatform.googleapis.com) in ${project} in Cloud Console, then sign in again`)
    }
    return project
  }
  const account = who ? ` for ${who}` : ""
  const usable = (projects ?? []).filter((project) => project.vertexEnabled === true)
  if (!usable.length) {
    throw stopped(`No Google Cloud project${account} has Vertex AI enabled, so nothing was registered. Create a Google Cloud project and enable the Vertex AI API (aiplatform.googleapis.com) in it in Cloud Console, then sign in again.`)
  }
  return validateProject(usable[0].projectId)
}

// Which Google account this sign-in serves.
//
// Signing in is the one thing a browser this plugin drives cannot do: Google
// refuses a sign-in from a browser that has a DevTools client attached ("This
// browser or app may not be secure"), and every way of driving Chrome — a
// debugging port, a debugging pipe — is such a client. Hiding the marks it is
// detected by is a race against Google's next change, so this does not try:
// the sign-in happens in a window with no debugging transport at all, opened
// by openSignInWindow, and the plugin closes that window when gcloud finishes.
// Later credits reads use the same Chrome profile, so the cookies set by hand
// are the cookies the Console is read with.
//
// The first account on a machine goes straight to gcloud's consent page. The
// add-account page exists to put a second identity into a profile that already
// has one; with nothing to add it is a page stood in front of the sign-in that
// asks the person to choose between nothing. Every later sign-in does open it,
// because there the choice is real: the account picked there is the account the
// consent page is approved as, so the cookies the credits are read with and the
// token gcloud writes belong to the same person. gcloud's own address is passed
// through untouched either way, which is what Google accepts.
function signInUrl(consentUrl, known) {
  if (!consentUrl) return known.size ? ADD_ACCOUNT_URL : consoleUrl(undefined)
  if (!known.size) return consentUrl
  const url = new URL(ADD_ACCOUNT_URL)
  // Replace the Console destination rather than append a second continue:
  // Google could otherwise choose the first one and never reach consent.
  // Treat gcloud's URL as one opaque value so decoding this outer parameter
  // returns the original state, redirect_uri and scope byte for byte.
  url.searchParams.set("continue", consentUrl)
  return url.href
}

export async function startLogin(options = {}, openWindow = openSignInWindow) {
  const wanted = authMode(options)
  const limit = Number(options.loginTimeout) > 0 ? Number(options.loginTimeout) : loginTimeout
  // Snapshot existing ADC accounts before this run writes credentials, so its
  // own ADC cannot make a newly approved account look like an existing one.
  const registered = await knownAccounts(options)
  let window
  let login
  let finished = false
  let cancelled = false
  let closing
  // Closing is shared by the timeout, the host and the normal end of sign-in.
  // Stop an unfinished writer before any cleanup, so it cannot recreate an ADC
  // after this run removed it.
  const close = () => {
    cancelled = true
    closing ??= (async () => {
      clearTimeout(timer)
      if (login && !finished) {
        login.child.kill("SIGKILL")
        await login.done.catch(() => {})
      }
      const opened = await Promise.resolve(window).catch(() => undefined)
      if (opened) await opened.close().catch(() => {})
    })()
    return closing
  }
  const timer = setTimeout(() => { void close().catch(() => {}) }, limit)
  timer.unref?.()
  const result = (async () => {
    const account = options.account
    const pinned = Boolean(options.cloudsdkConfig && !account)
    const creating = wanted !== "gcloud" && !pinned
    const root = options.adcRoot ? expandPath(options.adcRoot) : adcRoot()
    let directory = options.cloudsdkConfig
    let createdDirectory = false
    let chromeError
    let adcEmail
    let accountId
    let googleIdentity
    let releaseRegistration
    // An existing directory is never removed, even if this run made its ADC.
    // Conversely, an unnamed sign-in gets a unique directory that this run can
    // safely remove or rename without touching another sign-in's files.
    const discard = async () => {
      if (!directory || isGcloudDefault(directory)) return
      if (login?.file) await rm(login.file, { force: true })
      if (createdDirectory) await rm(directory, { recursive: true, force: true })
    }
    // Naming an existing ADC directory without an account is an explicit
    // read-only import, including recovery after consent succeeded but project
    // selection failed. It neither adds another ADC nor needs another consent
    // window; the host can save its project once the caller supplies it.
    if (pinned && wanted !== "gcloud") {
      const found = await resolveIdentity({ ...options, authMode: "adc" })
      const owner = await identityOf(await tokenProvider(found)())
      if (!owner?.subject) throw stopped("The existing ADC was kept, but its Google subject could not be confirmed; no account was recorded")
      return { ...found, ...owner, creditsSession: "unavailable", warning: "Existing ADC imported; the Chrome Console session was not checked" }
    }
    // Saving and reading ADC happens while the window is still open. A failure
    // here leaves through the block below, whose finally closes it.
    try {
      if (creating) {
        // OAuth must identify the account before duplicate detection. Always
        // stage consent in a fresh directory, even when an email was supplied.
        // An existing email-named directory is never overwritten or treated as
        // proof that this is the same Google account.
        await mkdir(root, { recursive: true, mode: 0o700 })
        directory = await mkdtemp(join(root, ".adc-pending-"))
        createdDirectory = true
        login = await beginAdcLogin({ ...options, cloudsdkConfig: directory })
      }
      const consentUrl = login ? await login.url : undefined
      if (cancelled) throw stopped("Google sign-in was stopped; no new account was saved")
      if (login && !consentUrl) {
        await login.done
        throw stopped("gcloud did not provide a consent page; no new account was added. Start the sign-in again")
      }
      // One undriven Chrome opens directly on AddSession with gcloud's consent
      // URL. Its window stays open until ADC is saved and read; only then does
      // this plugin close it. It is closed below, in this block's finally, on
      // every path out of the sign-in.
      window = openWindow({ profile: options.profile, profileDirectory: options.profileDirectory, url: signInUrl(consentUrl, registered), headless: false })
      const signing = await window
      await new Promise((resolve, reject) => {
        const expiry = setTimeout(() => reject(stopped(`Google sign-in did not finish within ${Math.round(limit / 60000)} minutes; start the sign-in again and approve the consent page in the window that opens`)), limit)
        expiry.unref?.()
        const completion = login ? login.done : signing.ended.then((error) => { if (error) throw error })
        completion.then(() => { finished = true; clearTimeout(expiry); resolve() }, (error) => { clearTimeout(expiry); reject(error) })
      })
    } catch (error) {
      chromeError = error
    }
    // The window is closed only when this section is done — by its own finally,
    // which every return and failure below goes through. The other closer is
    // the caller (close), on a cancellation or its timeout.
    try {
      if (creating && chromeError) {
        await discard()
        throw chromeError
      }
      if (creating) {
        // A successful gcloud exit is not proof of a new ADC: login.file is set
        // only when there was no file before this run. Reapproving an existing
        // ADC must not turn an overwrite into a new account record.
        if (!login.file) {
          await discard()
          throw stopped("The staging ADC already existed; refusing to replace credentials, so no new account was added")
        }
        if (!(await hasAdc({ cloudsdkConfig: directory }))) {
          await discard()
          throw stopped("Google sign-in created no readable ADC, so no new account was added. Start the sign-in again")
        }
        // Keep Google's stable subject from the first login, before an email
        // can change. Email alone cannot establish continuity across a rename.
        googleIdentity = await tokenProvider({ authMode: "adc", cloudsdkConfig: directory })()
          .then(identityOf).catch(() => undefined)
        adcEmail = googleIdentity?.account?.toLowerCase()
        if (!adcEmail || !googleIdentity?.subject) {
          throw stopped("The Google account email and subject could not be confirmed after consent; no new account was recorded")
        }
        // Serialize subject comparison AND registration across processes. Two
        // simultaneous logins with different email labels must not both add
        // the same subject. Staging directories are excluded from the scan.
        releaseRegistration = await take(`${root}.registration`, { timeout: limit })
        const existing = await registeredSubject(googleIdentity.subject, root)
        if (existing) throw stopped(`${adcEmail} was already signed in (same Google subject), so no new ADC was added. The existing credentials were kept`)
        // Magpie also keys the host record by accountId. If another managed
        // ADC currently owns this email under a different subject, keep both
        // accounts distinct with a stable subject-derived suffix.
        accountId = await registeredEmail(adcEmail, root)
          ? accountKeyFor(adcEmail, googleIdentity.subject) : adcEmail
        if (cancelled) throw stopped("Google sign-in was stopped; no new account was saved")
        // An explicit email is a user-selection constraint, not a dedup key.
        // Without a verified subject for that hint, do not silently approve a
        // different account on the person's behalf.
        if (account && adcEmail !== account.toLowerCase()) {
          throw stopped(`The consent page approved ${adcEmail}, not ${account}; no new account or ADC was saved. Sign in again and choose ${account} on Google's consent page.`)
        }
      }
      // A new ADC arrives with no project to serve yet. The one it is filed
      // with is the first of the account's projects with Vertex AI already
      // turned on; an account with none is not registered at all, and the
      // window closes on the way out as it does on every other failure.
      let project
      if (creating) {
        const named = options.project || process.env.GOOGLE_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT
        try {
          if (named) {
            // Nothing to ask and no list worth reading: an explicit project is
            // the answer, whether or not its API probe would have agreed.
            project = validateProject(named)
          } else {
            const token = await tokenProvider({ authMode: "adc", cloudsdkConfig: directory })()
            if (cancelled) throw stopped("Google sign-in was stopped; no new account was saved")
            const { projects, error } = await listUsableProjects(token)
            if (cancelled) throw stopped("Google sign-in was stopped; no new account was saved")
            if (!projects.some((project) => project.vertexEnabled) && error) {
              // An unreadable list is not an empty one: saying "create a
              // project" would be advice about a list this run never saw.
              throw stopped(`The Google Cloud projects for ${adcEmail} could not be listed (${error}), so nothing was registered. Sign in again, or set the project explicitly with GOOGLE_VERTEX_PROJECT`)
            }
            project = chooseProject({ projects, who: adcEmail, options })
          }
        } catch (failure) {
          // Nothing was registered: undo exactly what this run wrote.
          await discard()
          throw failure
        }
      }
      let found
      if (creating) {
        if (cancelled) throw stopped("Google sign-in was stopped; no new account was saved")
        const own = await availableAdcDirectory(adcEmail, googleIdentity.subject, root)
        await rename(directory, own)
        directory = own
      }
      try {
        found = await resolveIdentity({
          ...options,
          // The chosen project is this sign-in's answer, so it is handed to the
          // resolver rather than guessed at from Console or gcloud.
          ...(project ? { project } : {}),
          ...(creating ? { authMode: "adc", account: adcEmail } : {}),
          ...(directory ? { cloudsdkConfig: directory } : {}),
        })
      } catch (error) {
        if (!creating || error.code !== "VERTEX_PROJECT_REQUIRED") throw error
        // Consent already succeeded. Keep the account and ADC location available
        // even though the host cannot save a complete record without a project;
        // repeating OAuth would only hit the duplicate-account guard next time.
        return {
          account: adcEmail, authMode: "adc", cloudsdkConfig: directory, creditsSession: "ready",
          ...(googleIdentity?.subject ? { subject: googleIdentity.subject } : {}),
          warning: `ADC for ${adcEmail} was saved in ${directory}, but no Google Cloud project was selected. To finish registration without signing in again, set project to the project ID selected in Console, set cloudsdkConfig to this directory, and leave account unset.`,
        }
      }
      // Existing pinned ADC and explicit gcloud mode are read as they stand.
      // Their tokens are unrelated to a new consent flow and are not subjected
      // to the new-account checks above.
      let owner = found.account
      if (!creating) {
        const token = await tokenProvider(found)()
        googleIdentity = await identityOf(token)
        if (!googleIdentity?.subject) throw stopped("The Google subject could not be confirmed; no account was recorded")
        owner ??= found.authMode === "adc" ? googleIdentity?.account : undefined
      }
      const identity = {
        ...found,
        ...(owner ? { account: owner } : {}),
        ...(accountId ? { accountId } : {}),
        ...(googleIdentity?.subject ? { subject: googleIdentity.subject } : {}),
      }
      if (chromeError) return { ...identity, creditsSession: "unavailable", warning: chromeError.message }
      return { ...identity, creditsSession: "ready" }
    } catch (error) {
      // This run owns only its staged/new ADC. Every identity, duplicate,
      // cancellation or storage failure leaves pre-existing ADCs untouched.
      if (creating) await discard()
      throw error
    } finally {
      // The sign-in's window, whatever the outcome, is closed here: one window,
      // opened once, and the person never has to close it. A gcloud still
      // writing here (the failure paths above) is stopped first, as it always
      // was, so it cannot recreate an ADC after discard() removed it.
      if (login && !finished) {
        login.child.kill("SIGKILL")
        await login.done.catch(() => {})
      }
      try { await close() } finally { await releaseRegistration?.() }
    }
  })()
  // The host may await the callback later. Retain failures as a result without
  // a project, which the callback reports as failed instead of saving a row.
  const settled = result.catch((error) => ({ creditsSession: "unavailable", warning: error.message }))
  settled.finally(() => { void close().catch(() => {}) })
  // Internal cleanup must not await its own result. The caller's close also
  // joins identity/project work, so restoring a request stub or environment
  // after cancellation cannot leave a sign-in running against the next one.
  const drain = async () => { await close(); await settled }
  return { result: settled, close: drain, terminate: drain }
}
