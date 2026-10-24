import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { launch } from "./cdp.mjs"
import { apart, take, wanted } from "./lock.mjs"

// The browser here is the user's own Chrome, started for this plugin alone on a
// profile of its own. It is spoken to over Chrome's pipe transport (see
// cdp.mjs): no debugging port is opened and no Chrome the plugin did not start
// is ever attached to, so the Google session in that profile is reachable only
// from this process.

// The user's home as the environment states it. os.homedir() is the fallback,
// not the answer: a runner or a shell may set HOME for a process, and that is
// the home every path here is meant to be relative to.
export const home = () => process.env.HOME || process.env.USERPROFILE || homedir()

// The user's configuration root: what XDG_CONFIG_HOME names, else the platform's
// own place — %APPDATA% on Windows, ~/.config everywhere else. The variable is
// read first on every platform so a test or a sandbox can move the whole
// directory, and so a Windows user who sets it gets what they asked for.
export const configRoot = () => process.env.XDG_CONFIG_HOME
  || (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : join(home(), ".config"))

// The user's cache root, by the same rule: XDG_CACHE_HOME, else %LOCALAPPDATA%
// on Windows (a cache is machine-local, not roaming), else ~/.cache.
export const cacheRoot = () => process.env.XDG_CACHE_HOME
  || (process.platform === "win32" && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : join(home(), ".cache"))

export const defaultProfile = () => join(configRoot(), "gcp-auto-profile")
export const expandPath = (value) => resolve(value.startsWith("~/") ? join(home(), value.slice(2)) : value)

export async function safeGoto(page, url, options = { waitUntil: "domcontentloaded", timeout: 60000 }) {
  try {
    await page.goto(url, options)
  } catch (error) {
    if (!/ERR_ABORTED|frame was detached/i.test(error.message)) throw error
  }
}

// Where Chrome keeps its binary on each platform. The macOS entry is a path
// inside the app bundle, which is where Chrome installs itself for everyone.
export async function chromeExecutable() {
  if (process.env.VERTEX_CHROME_PATH) return expandPath(process.env.VERTEX_CHROME_PATH)
  const candidates = process.platform === "win32"
    ? [
      process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Chromium", "Application", "chrome.exe"),
    ].filter(Boolean)
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(home(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"]
  for (const path of candidates) {
    try { await access(path); return path } catch {}
  }
  throw new Error("Chrome not found; set VERTEX_CHROME_PATH to its executable")
}

// One browser at a time per profile, across processes: magpie asks each
// account's row separately and each may be a process of its own, so the wait
// for the profile lives on disk. A second process waits its turn instead of
// failing with "profile in use".
//
// Within one process there is no wait at all: the reads share one Chrome and
// take turns opening a tab (withPage below), which is what two accounts are —
// one browser, two tabs, one after the other.
const PROFILE_GAP = 0

// The gap after a process closed its Chrome and the next one starts another.
// Back to back by default: the profile is a session, not a file, and closing
// Chrome properly is enough. A machine that wants breathing room between
// browsers sets this in seconds.
function profileGap() {
  const raw = process.env.VERTEX_CHROME_GAP
  if (raw === undefined || raw === "") return PROFILE_GAP
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("VERTEX_CHROME_GAP must be a nonnegative number of seconds")
  return seconds * 1000
}

// How long a Chrome kept for reuse stays open with nothing to do. The accounts
// magpie asks are asked in one go and read one after the other, so a short
// window is enough to cover the whole batch: when the reads stop, the browser
// closes instead of sitting there. A read that comes later simply starts one
// again, which is no worse than opening a browser per read.
function idleAfter() {
  const raw = process.env.VERTEX_CHROME_IDLE
  if (raw === undefined || raw === "") return 30_000
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("VERTEX_CHROME_IDLE must be a nonnegative number of seconds")
  return seconds * 1000
}

// The lock is kept beside the cache rather than inside the Chrome profile: the
// profile is Chrome's own directory and nothing of this plugin's belongs in it.
export function profileLock(profilePath) {
  return join(cacheRoot(), "magpie", "gcp-ai", "profiles", createHash("sha256").update(profilePath).digest("hex").slice(0, 16))
}

async function claimProfile(profilePath, { timeout = 180000, gap = profileGap() } = {}) {
  const lockfile = profileLock(profilePath)
  const release = await take(lockfile, { timeout, busy: `The Chrome profile ${profilePath} is still busy with another Vertex operation; retry shortly` })
  try { await apart(lockfile, gap) } catch { /* a gap is a courtesy, not a requirement */ }
  return release
}

// A request handler that answers every request a page makes, for tests and for
// the offline HTML parser. It rides on the same pipe: the page's own network is
// paused at the request stage and continued or failed here, so a test never
// reaches Google and a document opened from a file never loads anything.
export async function routeAll(page, handler) {
  // The newest handler answers: a test that changes what its pages say only
  // calls this again, and the earlier one is dropped before the new one is
  // armed, instead of racing it.
  if (page.unroute) await page.unroute()
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] })
  const listener = (params) => {
    const request = params.request
    const respond = (response) => page.send("Fetch.fulfillRequest", {
      requestId: params.requestId, responseCode: 200,
      responseHeaders: [{ name: "content-type", value: response.contentType ?? "text/html; charset=utf-8" }],
      body: Buffer.from(response.body ?? "").toString("base64"),
    })
    Promise.resolve(handler({
      url: () => request.url,
      method: () => request.method,
      fulfill: respond,
      abort: () => page.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "Aborted" }),
      continue: () => page.send("Fetch.continueRequest", { requestId: params.requestId }),
    }))
      .then((response) => (response ? respond(response) : page.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "Aborted" })))
      .catch(() => {})
  }
  const previous = page.unroute
  const off = page.connection.subscribe("Fetch.requestPaused", listener, page.sessionId)
  page.unroute = async () => {
    off()
    await page.send("Fetch.disable").catch(() => {})
    await previous?.()
  }
  return page.unroute
}

// One read at a time per profile inside this process. Two accounts are read
// one after the other in the same browser; they must not drive it at once.
const chains = new Map()
// Browsers kept for the next read, by profile, with the timer that ends them.
const kept = new Map()

function serialize(key, task) {
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.catch(() => {})
  chains.set(key, tail)
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return run
}

// Ending the browsers this process kept. Without this a Chrome would be left
// running when the process ends for a reason other than the idle timer.
let ending = false
// This module is loaded inside magpie's plugin host, which other plugins share
// and which ends the process itself. A SIGINT handler that exits here would cut
// short that shutdown for every one of them, and an exit handler cannot await.
// So the exit path only does what can be done at once — kill the Chromes this
// process started — and leaves the process's own ending to its owner.
function endKept() {
  ending = true
  for (const [key, entry] of kept) {
    clearTimeout(entry.timer)
    clearInterval(entry.watch)
    kept.delete(key)
    try { entry.browser.child?.kill("SIGTERM") } catch {}
  }
}
process.once("exit", endKept)

// For a caller that means to leave nothing running, as a test does.
export async function closeKeptBrowsers() {
  const closing = [...kept.entries()].map(([key, entry]) => giveBack(key, entry))
  ending = false
  await Promise.all(closing)
}

// With nothing to do, the browser is kept for the next read and ends when it
// has gone unused. While it is kept it still holds the profile's lock, so it
// also watches for another process that wants the profile — a `magpie quota`
// on its own process, or a sign-in window — and steps aside at once rather
// than making that process sit out its whole patience.
function keepIdle(key, entry) {
  if (kept.get(key) !== entry) return
  clearTimeout(entry.timer)
  clearInterval(entry.watch)
  entry.timer = setTimeout(() => { void giveBack(key, entry).catch(() => {}) }, idleAfter())
  entry.timer.unref?.()
  entry.watch = setInterval(() => { void stepAside(key, entry).catch(() => {}) }, 2000)
  entry.watch.unref?.()
}

async function giveBack(key, entry) {
  clearTimeout(entry.timer)
  clearInterval(entry.watch)
  entry.timer = null
  entry.watch = null
  if (kept.get(key) === entry) kept.delete(key)
  await entry.handle.close().catch(() => {})
}

// Another process waiting on this profile outranks keeping the browser for
// the next read: it cannot make progress until this one lets go.
async function stepAside(key, entry) {
  if (ending || kept.get(key) !== entry) return
  if ((await wanted(entry.lockfile)) <= entry.takenAt) return
  await giveBack(key, entry)
}

// withPage is how a read uses the profile: a tab of the browser this process
// has open on it, or a browser opened for the occasion. The tab is closed when
// the read is done and the browser stays, so the next account's read is a tab
// rather than another Chrome — and it is closed once nothing has asked for a
// while. Reads on one profile take turns; reads on different profiles do not.
export async function withPage({ profile = defaultProfile(), headless = true, javaScriptEnabled = true, launchArgs = [] } = {}, use) {
  const profilePath = expandPath(profile)
  const key = JSON.stringify([profilePath, headless, javaScriptEnabled, launchArgs])
  return serialize(key, async () => {
    let entry = kept.get(key)
    if (entry) {
      clearTimeout(entry.timer)
      clearInterval(entry.watch)
      entry.timer = null
      entry.watch = null
      if (entry.browser.connection.closed || entry.browser.child.exitCode !== null) {
        kept.delete(key)
        entry = undefined
      }
    }
    if (!entry) {
      const handle = await openBrowser({ profile: profilePath, headless, javaScriptEnabled, launchArgs })
      entry = { handle, browser: handle.context, timer: null, watch: null, lockfile: profileLock(profilePath), takenAt: Date.now() }
      kept.set(key, entry)
      // A Chrome that ends on its own must not stay in the table.
      handle.context.connection.onClosed(() => {
        if (kept.get(key) === entry) kept.delete(key)
      })
    }
    const page = await entry.browser.newPage()
    try {
      return await use(page)
    } finally {
      await page.close().catch(() => {})
      if (!ending) {
        await stepAside(key, entry).catch(() => {})
        if (kept.get(key) === entry) keepIdle(key, entry)
      }
    }
  })
}

export async function openBrowser({ profile = defaultProfile(), headless = true, javaScriptEnabled = true, launchArgs = [] } = {}) {
  const profilePath = expandPath(profile)
  await mkdir(profilePath, { recursive: true, mode: 0o700 })
  let browser
  let downloadsPath
  let release = await claimProfile(profilePath)
  const cleanDownloads = async () => { if (downloadsPath) await rm(downloadsPath, { recursive: true, force: true }) }
  try {
    await mkdir(profilePath, { recursive: true, mode: 0o700 })
    downloadsPath = await mkdtemp(join(tmpdir(), "vertex-download-"))
    // Chrome is started plainly, with no automation flag. Its cookie store is
    // mocked as Playwright's own launch mocks it, so the profile neither
    // prompts for nor writes to the macOS Keychain or the Linux keyring.
    //
    // This browser is for reading, never for signing in: Google turns a sign-in
    // away from a browser that has a DevTools client attached ("This browser or
    // app may not be secure"), and a CDP-driven Chrome is exactly that. The
    // sign-in window is openSignInWindow below, which nothing drives.
    const args = [
      `--user-data-dir=${profilePath}`,
      "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-sync", "--disable-default-apps",
      "--disable-component-update", "--disable-client-side-phishing-detection",
      "--disable-domain-reliability", "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider",
      "--metrics-recording-only", "--no-service-autorun",
      // The same cookie store Playwright's launch uses: the profile's cookies
      // are encrypted with a key kept beside the profile, so neither the macOS
      // Keychain nor the Linux keyring is asked for anything.
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : process.platform === "linux" ? ["--password-store=basic"] : []),
      "--window-size=1440,1000",
      ...(headless ? ["--headless=new", "--disable-gpu"] : []),
      ...(javaScriptEnabled ? [] : ["--blink-settings=scriptEnabled=false"]),
      `--crash-dumps-dir=${downloadsPath}`,
      // Tests can refuse DNS for Chrome's background services too; page
      // interception alone cannot see those requests.
      ...launchArgs,
      "about:blank",
    ]
    const started = await launch(await chromeExecutable(), args)
    browser = started.browser
    const page = started.page
    // A Chrome that ends on its own (a crash, or a window the user closed)
    // releases the profile as surely as one this plugin closed.
    browser.connection.onClosed(() => { release(); void cleanDownloads().catch(() => {}) })
    const close = async () => {
      try { await browser.close() } finally { release(); await cleanDownloads() }
    }
    return { context: browser, page: Object.assign(page, { browser: () => browser }), close }
  } catch (error) {
    try { await browser?.close() } finally { release(); await cleanDownloads() }
    if (/Singleton|ProcessSingleton|profile.*in use|already in use/i.test(error.message)) {
      throw new Error(`Chrome profile is already open: ${profilePath}. Close Chrome using that profile and retry.`)
    }
    throw error
  }
}

// The window a person signs in to Google in.
//
// It is Chrome with no debugging transport of any kind: nothing of this plugin
// is attached to it, so there is no DevTools client for Google to find and the
// sign-in is an ordinary one. That is the whole point — a browser driven over
// CDP is turned away with "This browser or app may not be secure", and hiding
// the marks it is detected by is a race the plugin would lose on Google's next
// change. So this window is never driven: the person uses it, and the caller
// closes it once gcloud has finished the consent flow.
//
// The profile is the same one the credit reads use, which is what makes the
// cookies set here the cookies those reads are made with. Waiting is by
// process exit rather than by polling the profile, so the lock is held for as
// long as the window is open and no read can start on a profile Chrome is
// still writing.
//
// The address it opens is chosen by the caller. ADC sign-in opens directly on
// Google's add-account page with the consent URL as its continuation; `close`
// ends the window when gcloud finishes or the sign-in times out. The optional
// openTab hook also hands URLs to this window without attaching a client, for
// a caller that has a page to put in front of the person in the window they
// already have open.
export async function openSignInWindow({ profile = defaultProfile(), url, headless = false } = {}) {
  const profilePath = expandPath(profile)
  await mkdir(profilePath, { recursive: true, mode: 0o700 })
  const release = await claimProfile(profilePath)
  let downloadsPath
  const clean = async () => {
    if (downloadsPath) await rm(downloadsPath, { recursive: true, force: true }).catch(() => {})
    downloadsPath = undefined
  }
  try {
    downloadsPath = await mkdtemp(join(tmpdir(), "vertex-signin-"))
    const args = [
      `--user-data-dir=${profilePath}`,
      "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-sync", "--disable-default-apps",
      "--disable-component-update", "--disable-client-side-phishing-detection",
      "--disable-domain-reliability", "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider",
      "--metrics-recording-only", "--no-service-autorun",
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : process.platform === "linux" ? ["--password-store=basic"] : []),
      "--window-size=1440,1000",
      ...(headless ? ["--headless=new", "--disable-gpu"] : []),
      `--crash-dumps-dir=${downloadsPath}`,
      ...(url ? [url] : []),
    ]
    // No pipes on 3 and 4: those are what --remote-debugging-pipe would use, and
    // the point of this window is that no such client exists.
    const child = spawn(await chromeExecutable(), args, { stdio: "ignore", detached: false })
    let ended = false
    const exited = new Promise((resolve) => {
      const finish = (error) => {
        if (ended) return
        ended = true
        void clean().then(() => release())
        resolve(error)
      }
      child.once("exit", (code, signal) => finish(code === 0 || signal ? undefined : new Error(`Chrome exited with code ${code}`)))
      child.once("error", (error) => finish(new Error(error.code === "ENOENT"
        ? "Chrome not found; set VERTEX_CHROME_PATH to its executable"
        : `Chrome could not be started: ${error.message}`)))
    })
    // Waiting for the person, with no timeout of its own: the caller decides
    // how long a sign-in may take, and a window that closed for any reason is
    // reported by `ended` rather than guessed at from the profile.
    return {
      child,
      profile: profilePath,
      ended: exited,
      // A tab in the window that is already open. Chrome hands a URL given to
      // its binary to the running instance for that profile and exits at once,
      // so this opens a tab without attaching anything to the browser: there is
      // still no DevTools client, and no second Chrome is started.
      //
      // The URL is the last argument, and it is only ever one the caller built
      // (a local page or an https one): a string starting with "-" would be
      // read by Chrome as a switch, so it is refused rather than handed over.
      openTab: async (tabUrl) => {
        if (child.exitCode !== null || child.signalCode !== null) return false
        if (typeof tabUrl !== "string" || !/^(https?|file):\/\//i.test(tabUrl)) return false
        const helper = spawn(await chromeExecutable(), [
          `--user-data-dir=${profilePath}`,
          "--no-first-run", "--no-default-browser-check",
          ...(process.platform === "darwin" ? ["--use-mock-keychain"] : process.platform === "linux" ? ["--password-store=basic"] : []),
          tabUrl,
        ], { stdio: "ignore", detached: false })
        const handedOver = await new Promise((resolve) => {
          helper.once("exit", (code) => resolve(code === 0))
          helper.once("error", () => resolve(false))
        })
        return handedOver
      },
      // Ends the window the way the person would, and only if it is still open.
      close: async () => {
        if (child.exitCode !== null || child.signalCode !== null) { await exited; return }
        child.kill("SIGTERM")
        const stopped = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))])
        if (!stopped) { child.kill("SIGKILL"); await exited }
      },
    }
  } catch (error) {
    await clean()
    release()
    throw error
  }
}

export async function assertConsoleSession(page, { timeout = 20000 } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Console session timeout must be a positive number of milliseconds")
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("Google Cloud page closed while checking the session")
    let ready
    try {
      // A passive sign-in can display the identifier form before returning to
      // Console. Only a return to Console establishes success; give both forms
      // and redirects the same bounded grace period without entering anything.
      ready = await page.waitForFunction(() => {
        if (location.origin !== "https://console.cloud.google.com" || !document.body) return false
        const text = document.body.innerText
        const login = /Sign in with your Google Account|Sign in to (?:your )?Google Account/i.test(text)
          || (document.querySelector('input[type="password"], input[name="identifier"]') && /sign in/i.test(text))
        return text.trim() && !login ? { text } : false
      }, undefined, { timeout: Math.max(1, deadline - Date.now()) })
      const { text } = await ready.jsonValue()
      if (/You do not have permission|Permission denied|You need additional access/i.test(text)) throw new Error("Google Cloud Console permission denied for the signed-in Google account")
      return
    } catch (error) {
      if (page.isClosed()) throw new Error("Google Cloud page closed while checking the session", { cause: error })
      if (error.name === "TimeoutError") break
      if (!/Execution context was destroyed|Cannot find context with specified id|frame was detached/i.test(error.message)) throw error
    } finally { await ready?.dispose().catch(() => {}) }
  }
  throw new Error("Google session expired; automatic sign-in did not return to a signed-in Cloud Console before the timeout. Sign in with the Chrome profile again.")
}

// Runs in the page so SPA redirects and asynchronously populated context are
// observed together. Never choose an arbitrary project from a billing list.
function projectInConsole(waitForConsole = false) {
  if (location.hostname === "accounts.google.com") return waitForConsole ? null : "sign-in-required"
  if (location.origin !== "https://console.cloud.google.com") return null
  const valid = (value) => typeof value === "string" && /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value)
  let stored
  try { stored = window.sessionStorage.getItem("last_project_id") } catch {}
  for (const value of [new URL(location.href).searchParams.get("project"), window.cloudConsoleContext?.project?.id, stored]) {
    if (valid(value)) return value
  }
  const ids = [...new Set([...document.querySelectorAll("[data-project-id]")].map((element) => element.getAttribute("data-project-id")).filter(valid))]
  if (ids.length === 1) return ids[0]
  const linked = [...new Set([...document.querySelectorAll("a[href]")].flatMap((link) => {
    try {
      const url = new URL(link.href, location.href)
      const value = url.searchParams.get("project")
      return url.origin === location.origin && valid(value) ? [value] : []
    } catch { return [] }
  }))]
  if (!ids.length && linked.length === 1) return linked[0]
  return null
}

// The Console page carries the signed-in account in the same payload that
// names the project, under an obfuscated key. Reading that key is what makes
// the answer "who is signed in" rather than "which address appears first":
// a page can mention other accounts in its scripts and chooser markup, so a
// page without the key has no answer at all and none is invented.
function accountInPage() {
  const text = document.documentElement?.innerHTML ?? ""
  const keyed = text.match(/"oPEP7c":"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})"/)?.[1]
  if (keyed && !/(\.gserviceaccount\.com|@system\.|noreply|no-reply)/i.test(keyed)) return keyed
  return null
}

export async function extractAccount(page, { timeout = 20000 } = {}) {
  const found = await page.waitForFunction(accountInPage, undefined, { timeout }).catch(() => undefined)
  try { return found ? await found.jsonValue() : undefined } finally { await found?.dispose().catch(() => {}) }
}

// One page visit answers both questions, so this waits for either signal and
// reads both from the same DOM rather than loading the Console a second time.
export async function readConsole(page, { timeout = 30000 } = {}) {
  const found = await page.waitForFunction(projectInConsole, undefined, { timeout }).catch(() => undefined)
  let project
  try { project = found ? await found.jsonValue() : undefined } finally { await found?.dispose().catch(() => {}) }
  const account = await extractAccount(page, { timeout: 5000 })
  return { project: project === "sign-in-required" ? undefined : project ?? undefined, account }
}

export async function extractProjectId(page) {
  const requireProject = async (project) => {
    if (project === "sign-in-required") {
      await assertConsoleSession(page)
      const resolved = await page.waitForFunction(projectInConsole, true, { timeout: 20000 })
      try { project = await resolved.jsonValue() } finally { await resolved.dispose() }
    }
    return project ? validateProject(project) : undefined
  }
  // Prefer the active page before navigating away from a user-selected project.
  let current
  try { current = await page.evaluate(projectInConsole) } catch (error) {
    if (!/Execution context was destroyed|Cannot find context with specified id/i.test(error.message)) throw error
  }
  const project = await requireProject(current)
  if (project) return project
  // Billing pages need not carry a project. The console landing page resolves
  // the profile's default/active project without asking for a typed ID.
  await safeGoto(page, "https://console.cloud.google.com/?hl=en")
  let result
  try {
    result = await page.waitForFunction(projectInConsole, undefined, { timeout: 45000 })
    return await requireProject(await result.jsonValue())
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error("Cannot automatically identify the active Google Cloud project. Select the intended project in Cloud Console and retry.")
    throw error
  } finally { await result?.dispose() }
}

export function validateProject(project) {
  if (typeof project !== "string" || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) {
    throw new Error("Set GOOGLE_VERTEX_PROJECT to a Google Cloud project ID (not its display name)")
  }
  return project
}

export function validateBillingAccount(value) {
  if (typeof value !== "string" || !/^[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}$/.test(value)) {
    throw new Error("Invalid billing account ID; expected XXXXXX-XXXXXX-XXXXXX")
  }
  return value
}
