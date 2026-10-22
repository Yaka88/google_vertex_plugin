import { spawn } from "node:child_process"
import { access, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

// playwright-core is this plugin's only runtime dependency: it ships the CDP
// client, not a browser, and the Chrome it drives is the user's own. It is
// loaded when a browser is actually opened rather than when this module is, so
// a host can load the plugin and list its hooks on a machine that has not
// installed the dependency yet; opening a browser without it says so plainly.
let driver
async function chromium() {
  if (!driver) {
    const module = await import("playwright-core").catch(() => {
      throw new Error("playwright-core is missing; install this plugin's dependencies (bun install) so it can drive Chrome")
    })
    driver = module.chromium
  }
  return driver
}

export const defaultProfile = () => join(homedir(), ".config", "gcp-auto-profile")
export const expandPath = (value) => resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value)

export async function safeGoto(page, url, options = { waitUntil: "domcontentloaded", timeout: 60000 }) {
  try {
    await page.goto(url, options)
  } catch (error) {
    if (!/ERR_ABORTED|frame was detached/i.test(error.message)) throw error
  }
}

export async function chromeExecutable() {
  if (process.env.VERTEX_CHROME_PATH) return expandPath(process.env.VERTEX_CHROME_PATH)
  for (const path of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    try { await access(path); return path } catch {}
  }
  throw new Error("Chrome not found; set VERTEX_CHROME_PATH to its executable")
}

// A Chrome already running on this profile is reused rather than fought over
// for the SingletonLock: it may be the user's own window, or one whose sign-in
// outlasted the operation that started it. It is found through the process
// list rather than a fixed port, because its port is chosen per run.
async function runningChrome(profilePath) {
  if (process.platform !== "linux") return undefined
  for (const entry of (await readdir("/proc").catch(() => [])).filter((name) => /^\d+$/.test(name))) {
    let parts
    try { parts = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0").filter(Boolean) } catch { continue }
    if (parts.length === 1) parts = parts[0].split(" ")
    if (!parts.some((part) => /(^|\/)chrome$/.test(part))) continue
    const argument = parts.find((value) => value.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length)
    const port = parts.find((value) => value.startsWith("--remote-debugging-port="))?.slice("--remote-debugging-port=".length)
    if (!argument || !port) continue
    if (expandPath(argument.replace(/^["']|["']$/g, "")) !== profilePath) continue
    return { pid: Number(entry), port: Number(port) }
  }
  return undefined
}

async function attachTo(profilePath, downloadsPath, port) {
  let response
  try { response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }) } catch { return }
  if (!response.ok) throw new Error(`Chrome debugging port ${port} did not return a valid browser endpoint`)
  const version = await response.json()
  const endpoint = new URL(version.webSocketDebuggerUrl)
  if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.port !== String(port)) {
    throw new Error(`Chrome debugging port ${port} must refer to a local Chrome browser`)
  }
  const connection = await (await chromium()).connectOverCDP(endpoint.href, { artifactsDir: downloadsPath, timeout: 10000 })
  try {
    const session = await connection.newBrowserCDPSession()
    let pid
    try {
      const info = await session.send("SystemInfo.getProcessInfo")
      pid = info.processInfo.find((process) => process.type === "browser")?.id
    } finally { await session.detach() }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Cannot identify the Chrome process on debugging port ${port}`)
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8")
    let parts = raw.split("\0").filter(Boolean)
    if (parts.length === 1) parts = parts[0].split(" ")
    let argument = parts.find((value) => value.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length)
    if (!argument) {
      const index = parts.indexOf("--user-data-dir")
      if (index >= 0 && parts[index + 1]) argument = parts[index + 1]
    }
    if (argument) argument = expandPath(argument.replace(/^["']|["']$/g, ""))
    if (!argument || argument !== profilePath) throw new Error(`Chrome on port ${port} must use profile ${profilePath}`)
    const context = connection.contexts()[0]
    if (!context) throw new Error(`Chrome on port ${port} has no persistent browser context`)
    return { connection, context }
  } catch (error) { await connection.close(); throw error }
}

async function attachedBrowser(profilePath, downloadsPath) {
  const reused = await runningChrome(profilePath)
  if (reused) return attachTo(profilePath, downloadsPath, reused.port)
  let response
  try { response = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1500) }) } catch { return }
  if (!response.ok) throw new Error("Chrome debugging port 9222 did not return a valid browser endpoint")
  const version = await response.json()
  const endpoint = new URL(version.webSocketDebuggerUrl)
  if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.port !== "9222") {
    throw new Error("Chrome debugging port 9222 must refer to a local Chrome browser")
  }
  // CDP can belong to a different profile. Verify the Linux process before
  // attaching rather than silently authenticating with another Google account.
  if (process.platform !== "linux") throw new Error("Cannot verify the Chrome profile on debugging port 9222 on this platform; close that browser and retry")
  const connection = await (await chromium()).connectOverCDP(endpoint.href, { artifactsDir: downloadsPath, timeout: 10000 })
  try {
    const session = await connection.newBrowserCDPSession()
    let pid
    try {
      const info = await session.send("SystemInfo.getProcessInfo")
      pid = info.processInfo.find((process) => process.type === "browser")?.id
    } finally { await session.detach() }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Cannot identify the Chrome process on debugging port 9222")
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8")
    let parts = raw.split("\0").filter(Boolean)
    // Chrome may rewrite argv as a space-separated process title, with a URL
    // following the profile argument instead of another command-line flag.
    if (parts.length === 1) parts = parts[0].split(" ")
    let argument = parts.find((value) => value.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length)
    if (!argument) {
      const index = parts.indexOf("--user-data-dir")
      if (index >= 0 && parts[index + 1]) argument = parts[index + 1]
    }
    if (argument) argument = expandPath(argument.replace(/^["']|["']$/g, ""))
    if (!argument || argument !== profilePath) throw new Error(`Chrome on debugging port 9222 must use profile ${profilePath}`)
    const context = connection.contexts()[0]
    if (!context) throw new Error("Chrome on debugging port 9222 has no persistent browser context")
    return { connection, context }
  } catch (error) { await connection.close(); throw error }
}

async function freePort() {
  const server = createServer()
  try {
    await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done) })
    return server.address().port
  } finally { server.close() }
}

async function debugEndpoint(port, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return await response.json()
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return undefined
}

// Playwright's own launch leaves navigator.webdriver true, and Google's sign-in
// answers that with "This browser or app may not be secure". Chrome started as
// an ordinary process and attached over CDP reports no such marker, so the
// visible sign-in window is launched here and driven through that connection.
async function launchedBrowser(profilePath, downloadsPath) {
  const port = await freePort()
  const child = spawn(await chromeExecutable(), [
    `--user-data-dir=${profilePath}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run", "--no-default-browser-check",
    "--window-size=1440,1000",
    "about:blank",
  ], { stdio: "ignore", detached: false })
  let exited
  const exit = new Promise((resolve) => { child.once("exit", (code) => { exited = code ?? 0; resolve(code ?? 0) }) })
  try {
    const version = await debugEndpoint(port)
    if (!version) throw new Error("Chrome did not open a debugging endpoint; set VERTEX_CHROME_PATH to a working Chrome")
    const endpoint = new URL(version.webSocketDebuggerUrl)
    if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.port !== String(port)) {
      throw new Error("Chrome's debugging endpoint is not the local one that was started")
    }
    const connection = await (await chromium()).connectOverCDP(endpoint.href, { artifactsDir: downloadsPath, timeout: 15000 })
    try {
      const context = connection.contexts()[0]
      if (!context) throw new Error("The Chrome that was started has no browser context")
      const page = context.pages()[0] ?? await context.newPage()
      page.setDefaultTimeout(20000)
      // Closing the connection only detaches Playwright; the Chrome this run
      // started is a process of its own and is ended with it.
      const close = async () => {
        try { await connection.close() } finally {
          if (exited === undefined) child.kill("SIGTERM")
          await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5000))])
          if (exited === undefined) child.kill("SIGKILL")
        }
      }
      return { context, page, close }
    } catch (error) { await connection.close(); throw error }
  } catch (error) {
    if (exited === undefined) child.kill("SIGKILL")
    throw error
  }
}

// One browser operation at a time per profile. Two accounts may share a
// profile (and one Chrome window), but two operations must not drive the same
// window at once.
const active = new Set()
export async function openBrowser({ profile = defaultProfile(), headless = true, javaScriptEnabled = true } = {}) {
  const profilePath = expandPath(profile)
  if (active.has(profilePath)) throw new Error("The Chrome profile is in use by another Vertex operation; retry after it finishes")
  const operation = Symbol()
  active.add(profilePath)
  let downloadsPath
  let context
  const release = () => { active.delete(profilePath) }
  const cleanDownloads = async () => { if (downloadsPath) await rm(downloadsPath, { recursive: true, force: true }) }
  try {
    await mkdir(profilePath, { recursive: true, mode: 0o700 })
    // Each browser run receives an empty, private temporary download directory.
    downloadsPath = await mkdtemp(join(tmpdir(), "vertex-download-"))
    const attached = javaScriptEnabled && process.platform === "linux" ? await attachedBrowser(profilePath, downloadsPath) : undefined
    if (attached) {
      let page
      attached.connection.on("disconnected", () => { release(); void cleanDownloads().catch(() => {}) })
      try {
        page = await attached.context.newPage()
        page.setDefaultTimeout(20000)
        const close = async () => {
          try { await page.close() } finally {
            try { await attached.connection.close() } finally { release(); await cleanDownloads() }
          }
        }
        // A Chrome this plugin did not start is the user's: only this
        // operation's tab and the CDP connection are closed with it.
        return { context: attached.context, page, close }
      } catch (error) { await attached.connection.close(); throw error }
    }
    // A visible run signs in to Google, which turns away a browser carrying the
    // automation marker; start Chrome plainly and drive it over CDP instead.
    if (!headless && process.platform === "linux") {
      const launched = await launchedBrowser(profilePath, downloadsPath)
      const close = async () => { try { await launched.close() } finally { release(); await cleanDownloads() } }
      return { context: launched.context, page: launched.page, close }
    }
    context = await (await chromium()).launchPersistentContext(profilePath, {
      executablePath: await chromeExecutable(), headless, acceptDownloads: false, javaScriptEnabled, downloadsPath,
      locale: "en-US", viewport: { width: 1440, height: 1000 },
      timeout: 30000, chromiumSandbox: true,
      // Keep Chrome's native keyring access so the existing profile's cookies
      // remain readable, and leave Chrome's sandbox enabled.
      ignoreDefaultArgs: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain", "--enable-automation"],
      args: ["--no-first-run", "--no-default-browser-check"],
    })
    context.on("close", () => { release(); void cleanDownloads().catch(() => {}) })
    context.setDefaultTimeout(20000)
    const page = context.pages()[0] ?? await context.newPage()
    const close = async () => { try { await context.close() } finally { release(); await cleanDownloads() } }
    return { context, page, close }
  } catch (error) {
    try { await context?.close() } finally { release(); await cleanDownloads() }
    if (/Singleton|ProcessSingleton|profile.*in use/i.test(error.message)) {
      throw new Error(`Chrome profile is already open: ${profilePath}. Close Chrome using that profile and retry.`)
    }
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
// a page can mention other accounts in its scripts and chooser markup.
function accountInPage() {
  const text = document.documentElement?.innerHTML ?? ""
  const keyed = text.match(/"oPEP7c":"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})"/)?.[1]
  if (keyed && !/(\.gserviceaccount\.com|@system\.|noreply|no-reply)/i.test(keyed)) return keyed
  const found = [...new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])]
  return found.find((address) => !/(\.gserviceaccount\.com|@system\.|noreply|no-reply)/i.test(address)) ?? null
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
  if (project === "sign-in-required") return { project: undefined, account: await extractAccount(page, { timeout: 5000 }) }
  const account = await extractAccount(page, { timeout: 5000 })
  return { project: project ?? undefined, account }
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
