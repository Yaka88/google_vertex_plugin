import { createHash } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { assertConsoleSession, defaultProfile, expandPath, openBrowser, safeGoto, validateBillingAccount, validateProject } from "./browser.mjs"
import { effectiveAuthMode, resolveProject, validateAccount } from "./credentials.mjs"

const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim()
const column = (headers, name) => headers.findIndex((h) => normalize(h).toLowerCase() === name)
const money = (value) => {
  const text = normalize(value)
  const match = /^(?:US\$|\$|USD\s*)([\d,]+)(?:\.(\d{2}))?(?:\s*USD)?$/.exec(text)
  if (!match) throw new Error(`Unsupported credit amount/currency: ${text}. This plugin requires USD billing.`)
  return Number(match[1].replaceAll(",", "")) * 100 + Number(match[2] ?? 0)
}
const isoDate = (value) => {
  const text = normalize(value)
  if (!text) return undefined
  const dateOnly = /^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/.test(text)
  const ms = Date.parse(dateOnly ? text + " 00:00:00 UTC" : text)
  if (!Number.isFinite(ms)) throw new Error(`Unsupported Google Cloud credit date: ${text}`)
  return new Date(ms).toISOString()
}

// Column names are read from the rendered table, not token offsets or the
// unrelated dollar amounts in overview widgets and expired-credit tooltips.
export function parseCreditTables(tables, { now = Date.now() } = {}) {
  const credits = new Map()
  let recognized = false
  for (const table of tables) {
    const headers = table.headers.map(normalize)
    const indices = Object.fromEntries(["credit name", "status", "remaining value", "original value", "credit id", "start date", "end date", "usage scope"].map((name) => [name, column(headers, name)]))
    if (["credit name", "status", "remaining value", "original value", "credit id"].some((name) => indices[name] < 0)) continue
    recognized = true
    for (const row of table.rows) {
      const cell = (name) => normalize(row[indices[name]])
      const status = cell("status").toLowerCase()
      if (!["available", "active", "exhausted", "used up", "used", "expired", "pending"].includes(status)) throw new Error(`Unknown Google Cloud credit status: ${cell("status")}`)
      const id = cell("credit id")
      if (!id || credits.has(id)) continue
      const reported = money(cell("remaining value"))
      const original = money(cell("original value"))
      if (!Number.isSafeInteger(reported) || !Number.isSafeInteger(original) || reported < 0 || reported > original) throw new Error("Invalid Google Cloud credit amounts")
      const remaining = ["exhausted", "used up", "used"].includes(status) ? 0 : reported
      const start = isoDate(cell("start date"))
      const end = isoDate(cell("end date"))
      const eligible = ["available", "active", "exhausted", "used up", "used"].includes(status) && !(start && Date.parse(start) > now) && !(end && Date.parse(end) <= now)
      credits.set(id, { id, name: cell("credit name"), status: cell("status"), remaining: remaining / 100, original: original / 100, start, end, scope: cell("usage scope"), eligible })
    }
  }
  if (!recognized || !credits.size) throw new Error("Google Cloud Credits table was not found or is empty; the session may be expired, the page may still be loading, or its layout changed")
  const active = [...credits.values()].filter((credit) => credit.eligible)
  const remaining = active.reduce((sum, credit) => sum + Math.round(credit.remaining * 100), 0)
  const original = active.reduce((sum, credit) => sum + Math.round(credit.original * 100), 0)
  const ends = active.filter((credit) => credit.remaining > 0 && credit.end).map((credit) => credit.end).sort()
  const soonest = ends[0]
  return {
    currency: "USD", remaining: remaining / 100, original: original / 100, used: (original - remaining) / 100,
    usedPercent: original > 0 ? ((original - remaining) * 100) / original : 100,
    ...(soonest ? { runsOutAt: soonest, runsOut: active.filter((c) => c.end === soonest).reduce((s, c) => s + Math.round(c.remaining * 100), 0) / 100 } : {}),
    credits: [...credits.values()], fetchedAt: new Date(now).toISOString(), cached: false,
  }
}

export async function readTables(page) {
  return page.evaluate(() => [...document.querySelectorAll("table, [role='grid'], [role='table']")].map((table) => ({
    headers: [...table.querySelectorAll("thead th, [role='columnheader']")].map((cell) => cell.innerText),
    rows: [...table.querySelectorAll("tbody tr, [role='row']")].map((row) => [...row.querySelectorAll("td, [role='gridcell'], [role='cell']")].map((cell) => cell.innerText)).filter((row) => row.length),
  })))
}

export async function discoverBillingAccount(page, project, account) {
  validateProject(project)
  if (account) validateAccount(account)
  await safeGoto(page, `https://console.cloud.google.com/billing/linkedaccount?project=${encodeURIComponent(project)}&hl=en${account ? `&authuser=${encodeURIComponent(account)}` : ""}`)
  await page.waitForFunction(() => location.hostname === "accounts.google.com" || /billing\/[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}/i.test(location.href) || [...document.querySelectorAll("a[href]")].some((a) => /\/billing\/[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}/i.test(a.href)), undefined, { timeout: 45000 }).catch(() => {})
  await assertConsoleSession(page)
  await page.waitForFunction(() => /billing\/[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}/i.test(location.href) || [...document.querySelectorAll("a[href]")].some((a) => /\/billing\/[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}/i.test(a.href)), undefined, { timeout: 20000 }).catch((error) => { if (error.name !== "TimeoutError") throw error })
  const urls = [page.url(), ...await page.locator("a[href]").evaluateAll((links) => links.map((link) => link.href))]
  const accounts = [...new Set(urls.flatMap((url) => [...url.matchAll(/\/billing\/([0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6})(?:[/?#]|$)/gi)].map((m) => m[1])))]
  if (accounts.length !== 1) throw new Error("Cannot uniquely identify the project's billing account; set VERTEX_BILLING_ACCOUNT explicitly")
  return accounts[0]
}

async function scrape(options) {
  const own = !options.browser
  const browser = options.browser ?? await openBrowser({ profile: options.profile, headless: options.headless ?? true })
  try {
    const account = options.billingAccount ? validateBillingAccount(options.billingAccount) : await discoverBillingAccount(browser.page, options.project, options.account)
    const source = `https://console.cloud.google.com/billing/${account}/credits/all?hl=en${options.account ? `&authuser=${encodeURIComponent(options.account)}` : ""}`
    await safeGoto(browser.page, source)
    await browser.page.waitForFunction(() => location.hostname === "accounts.google.com" || [...document.querySelectorAll("th, [role='columnheader']")].some((cell) => cell.innerText.trim() === "Remaining value"), undefined, { timeout: 45000 }).catch(() => {})
    await assertConsoleSession(browser.page)
    await browser.page.waitForFunction(() => [...document.querySelectorAll("tbody tr, [role='row']")].some((row) => /\$\s*\d/.test(row.innerText)), undefined, { timeout: 30000 })
    const tables = []
    const seen = new Set()
    for (let index = 0; index < 100; index++) {
      const next = await readTables(browser.page)
      const signature = JSON.stringify(next)
      if (seen.has(signature)) throw new Error("Credits pagination did not advance; refusing an incomplete balance")
      seen.add(signature)
      tables.push(...next)
      const button = browser.page.getByRole("button", { name: /^(?:Go to )?Next page$/i })
      if (!(await button.count()) || !(await button.first().isEnabled())) return { ...parseCreditTables(tables), billingAccount: account, source }
      await button.first().click()
      await browser.page.waitForFunction((before) => {
        const tables = [...document.querySelectorAll("table, [role='grid'], [role='table']")].map((table) => ({
          headers: [...table.querySelectorAll("thead th, [role='columnheader']")].map((cell) => cell.innerText),
          rows: [...table.querySelectorAll("tbody tr, [role='row']")].map((row) => [...row.querySelectorAll("td, [role='gridcell'], [role='cell']")].map((cell) => cell.innerText)).filter((row) => row.length),
        }))
        return JSON.stringify(tables) !== before
      }, signature, { timeout: 20000 })
    }
    throw new Error("Credits table exceeded 100 pages; refusing an incomplete balance")
  } finally { if (own) await browser.close() }
}

const pending = new Map()

// A lock left by a process that has ended (a crash, a kill, or a reboot) must
// not block every later read. The PID it names is checked against the running
// processes, and that process's start time against the lock's own, so a PID
// the machine handed out again after a reboot is not taken for the holder.
async function abandoned(path) {
  const locked = (await stat(path)).mtimeMs
  let pid
  try { pid = Number((await readFile(path, "utf8")).trim()) } catch { return Date.now() - locked > 10000 }
  // An empty lock is one just created by another process, not one abandoned:
  // only a lock that stayed empty is stale.
  if (!pid) return Date.now() - locked > 10000
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  if (process.platform !== "linux") return Date.now() - locked > 10 * 60 * 1000
  try {
    // On Linux /proc/<pid>'s mtime is the process's start time.
    const started = (await stat(`/proc/${pid}`)).mtimeMs
    return started > locked + 1000
  } catch { return true }
}

async function acquireLock(file) {
  const path = `${file}.lock`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600)
      await handle.writeFile(String(process.pid))
      return handle
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (attempt === 0 && await abandoned(path)) { await rm(path, { force: true }); continue }
      throw new Error("Another process is refreshing Vertex credits; retry shortly")
    }
  }
  throw new Error("Another process is refreshing Vertex credits; retry shortly")
}

export async function fetchCredits(options = {}) {
  const settings = {
    ...options,
    profile: options.profile ?? process.env.VERTEX_CHROME_PROFILE ?? defaultProfile(),
    project: options.project ?? process.env.GOOGLE_VERTEX_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT,
    billingAccount: options.billingAccount ?? process.env.VERTEX_BILLING_ACCOUNT,
    account: options.account ?? process.env.VERTEX_GCLOUD_ACCOUNT,
  }
  if (settings.billingAccount) validateBillingAccount(settings.billingAccount)
  else settings.project = await resolveProject(settings, undefined, await effectiveAuthMode(settings))
  if (settings.project) validateProject(settings.project)
  if (settings.account) validateAccount(settings.account)
  // The Chrome profile alone does not tell two Google accounts apart: one
  // profile can hold both, so each read also names the account whose cookies
  // it used (and, when it has one, that account's own ADC directory).
  const identity = JSON.stringify([expandPath(settings.profile), settings.project ?? "", settings.billingAccount ?? "", settings.account ?? "", settings.cloudsdkConfig ?? ""])
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24)
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")
  const file = join(base, "magpie", "gcp-ai", `credits-${digest}.json`)
  const ttl = Number(options.ttl ?? process.env.VERTEX_CREDITS_CACHE_TTL ?? 300)
  if (!Number.isFinite(ttl) || ttl < 0) throw new Error("VERTEX_CREDITS_CACHE_TTL must be a nonnegative number of seconds")
  const cached = async () => {
    try {
      const data = JSON.parse(await readFile(file, "utf8"))
      const age = Date.now() - Date.parse(data.fetchedAt)
      const futureExpiry = !data.runsOutAt || Date.parse(data.runsOutAt) > Date.now()
      if (!settings.force && age >= 0 && age < ttl * 1000 && futureExpiry && data.currency === "USD" && Number.isFinite(data.remaining) && Number.isFinite(data.original) && Number.isFinite(data.usedPercent)) return { ...data, cached: true }
    } catch {}
  }
  const hit = await cached()
  if (hit) return hit
  if (pending.has(file)) return pending.get(file)
  const task = (async () => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const lock = await acquireLock(file)
    try {
      const again = await cached()
      if (again) return again
      const result = await scrape(settings)
      const temp = `${file}.${process.pid}.tmp`
      try {
        await writeFile(temp, JSON.stringify(result) + "\n", { mode: 0o600, flag: "wx" })
        await rename(temp, file)
      } finally { await rm(temp, { force: true }) }
      return result
    } finally { await lock.close(); await rm(`${file}.lock`, { force: true }) }
  })().finally(() => pending.delete(file))
  pending.set(file, task)
  return task
}

export function usageOf(credits) {
  return {
    plan: "Google Cloud promotional credits", balance: `$${credits.remaining.toFixed(2)} USD`, signIn: "kept",
    windows: [{
      name: "Promotional Credits", used: credits.usedPercent,
      display: `$${credits.remaining.toFixed(2)} remaining / $${credits.original.toFixed(2)} USD${credits.cached ? " (cached)" : ""}`,
      amount: credits.used, limit: credits.original, unit: "USD",
      ...(credits.runsOutAt ? { runsOutAt: credits.runsOutAt, runsOut: credits.runsOut } : {}),
    }],
  }
}
