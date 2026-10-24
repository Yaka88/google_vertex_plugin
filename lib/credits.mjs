import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { assertConsoleSession, cacheRoot, defaultProfile, expandPath, extractAccount, safeGoto, validateBillingAccount, validateProject, withPage } from "./browser.mjs"
import { take } from "./lock.mjs"
import { effectiveAuthMode, resolveProject, validateAccount } from "./credentials.mjs"

const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim()
// Failures that say something about the network at this moment rather than
// about the account: they are remembered for a minute, not twenty.
const NETWORK_FAILURE = /ERR_(?:TIMED_OUT|CONNECTION|NETWORK|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|PROXY|TUNNEL|SSL|EMPTY_RESPONSE)|net::ERR_|timed out after|TimeoutError|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i
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
  const urls = [await page.url(), ...(await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((link) => link.href)) ?? [])]
  const accounts = [...new Set(urls.flatMap((url) => [...url.matchAll(/\/billing\/([0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6})(?:[/?#]|$)/gi)].map((m) => m[1])))]
  if (accounts.length !== 1) throw new Error("Cannot uniquely identify the project's billing account; set VERTEX_BILLING_ACCOUNT explicitly")
  return accounts[0]
}

// The Console pages the table in place. The button is found by the words it
// shows — Google's own label is "Next page" — and clicked in the page, which
// needs nothing of the browser beyond evaluating an expression.
async function nextPage(page) {
  return page.evaluate(() => {
    const label = (element) => (element.getAttribute("aria-label") ?? element.innerText ?? "").trim()
    const button = [...document.querySelectorAll("button, [role='button']")].find((element) => /^(?:Go to )?Next page$/i.test(label(element)))
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return false
    button.click()
    return true
  })
}

// The account the page was rendered for. authuser picks it, but Google may
// silently fall back to the profile's default account, and a balance read as
// the wrong person is worse than no balance: it is a plausible wrong number on
// someone else's row. So every read that names an account checks that the page
// agrees, and refuses rather than report another account's credits.
async function confirmAccount(page, account) {
  if (!account) return
  const shown = await extractAccount(page, { timeout: 8000 })
  // A page that never named an account is not evidence that it named this one.
  // A fallback to another authuser is exactly what the check is for, and it is
  // silent: the URL still says this account while the page is another person's.
  if (!shown) throw new Error(`Cloud Console did not show which account the credits belong to; refusing to report a balance that may be another account's. Sign in as ${account} in the Chrome profile and retry`)
  if (shown.toLowerCase() !== account.toLowerCase()) {
    throw new Error(`Cloud Console is signed in as ${shown}, not ${account}; sign in as ${account} in the Chrome profile and retry`)
  }
}

async function readPage(page, options) {
  // How long the Console is given to show the credits table. The first wait is
  // only a hint that the page has started answering: what decides the read is
  // assertConsoleSession below (which says a lapsed session is a lapsed
  // session) and the table's own wait, whose timeout is the failure to report.
  const wait = (fallback) => (Number(options.scrapeTimeout) > 0 ? Math.min(Number(options.scrapeTimeout), fallback) : fallback)
  const account = options.billingAccount ? validateBillingAccount(options.billingAccount) : await discoverBillingAccount(page, options.project, options.account)
  const source = `https://console.cloud.google.com/billing/${account}/credits/all?hl=en${options.account ? `&authuser=${encodeURIComponent(options.account)}` : ""}`
  await safeGoto(page, source)
  await page.waitForFunction(() => location.hostname === "accounts.google.com" || [...document.querySelectorAll("th, [role='columnheader']")].some((cell) => cell.innerText.trim() === "Remaining value"), undefined, { timeout: wait(45000) }).catch(() => {})
  await assertConsoleSession(page, { timeout: wait(20000) })
  // The table is the read: a page that never shows one is not a balance, and
  // the error says which of the two waits ran out.
  await page.waitForFunction(() => [...document.querySelectorAll("tbody tr, [role='row']")].some((row) => /\$\s*\d/.test(row.innerText)), undefined, { timeout: wait(30000) })
    .catch(() => { throw new Error("Google Cloud Credits table was not found or is empty; the session may be expired, the page may still be loading, or its layout changed") })
  await confirmAccount(page, options.account)
  const tables = []
  const seen = new Set()
  for (let index = 0; index < 100; index++) {
    const next = await readTables(page)
    const signature = JSON.stringify(next)
    if (seen.has(signature)) throw new Error("Credits pagination did not advance; refusing an incomplete balance")
    seen.add(signature)
    tables.push(...next)
    if (!(await nextPage(page))) return { ...parseCreditTables(tables), billingAccount: account, source }
    await page.waitForFunction((before) => {
      const tables = [...document.querySelectorAll("table, [role='grid'], [role='table']")].map((table) => ({
        headers: [...table.querySelectorAll("thead th, [role='columnheader']")].map((cell) => cell.innerText),
        rows: [...table.querySelectorAll("tbody tr, [role='row']")].map((row) => [...row.querySelectorAll("td, [role='gridcell'], [role='cell']")].map((cell) => cell.innerText)).filter((row) => row.length),
      }))
      return JSON.stringify(tables) !== before
    }, signature, { timeout: 20000 })
  }
  throw new Error("Credits table exceeded 100 pages; refusing an incomplete balance")
}

async function scrape(options) {
  // A caller that brought its own browser (a test, or a sign-in that already
  // has a window) reads on its page; otherwise the read takes a tab of the
  // browser this process keeps for the profile, so a second account costs a
  // tab rather than another Chrome.
  if (options.browser) return readPage(options.browser.page, options)
  return withPage({ profile: options.profile, headless: options.headless ?? true }, (page) => readPage(page, options))
}

const pending = new Map()

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
  const file = join(cacheRoot(), "magpie", "gcp-ai", `credits-${digest}.json`)
  // The cache is what keeps this from opening a browser on every poll, so both
  // outcomes are kept: a balance for a few minutes, a failure for much longer.
  // The usual failures — no billing.viewer on the project, a billing account in
  // another currency, a Console layout change, nobody signed in to the profile
  // — do not fix themselves between two usage polls, and asking again would
  // open a browser for an answer that cannot change.
  const ttl = Number(options.ttl ?? process.env.VERTEX_CREDITS_CACHE_TTL ?? 300)
  if (!Number.isFinite(ttl) || ttl < 0) throw new Error("VERTEX_CREDITS_CACHE_TTL must be a nonnegative number of seconds")
  const cached = async () => {
    try {
      const data = JSON.parse(await readFile(file, "utf8"))
      const age = Date.now() - Date.parse(data.failedAt ?? data.fetchedAt)
      if (settings.force || !(age >= 0)) return undefined
      if (data.failedAt) return age < (transient(data) ? transientTtl : failureTtl) * 1000 ? { ...data, cached: false } : undefined
      const futureExpiry = !data.runsOutAt || Date.parse(data.runsOutAt) > Date.now()
      if (age < ttl * 1000 && futureExpiry && data.currency === "USD" && Number.isFinite(data.remaining) && Number.isFinite(data.original) && Number.isFinite(data.usedPercent)) return { ...data, cached: true }
    } catch {}
  }
  const failureTtl = Number(options.failureTtl ?? process.env.VERTEX_CREDITS_FAILURE_TTL ?? 1200)
  if (!Number.isFinite(failureTtl) || failureTtl < 0) throw new Error("VERTEX_CREDITS_FAILURE_TTL must be a nonnegative number of seconds")
  // A failure that is about this moment — a network that dropped, a Console
  // that took too long, a Chrome still starting — is not a property of the
  // account, so remembering it for twenty minutes is how a single bad minute
  // becomes twenty minutes of "timed out" on the row. Only the stable answers
  // (no billing.viewer, an expired session, a layout change) are kept that long.
  const transientTtl = Number(options.transientTtl ?? process.env.VERTEX_CREDITS_TRANSIENT_TTL ?? 60)
  if (!Number.isFinite(transientTtl) || transientTtl < 0) throw new Error("VERTEX_CREDITS_TRANSIENT_TTL must be a nonnegative number of seconds")
  const transient = (data) => NETWORK_FAILURE.test(String(data?.error ?? ""))
  const save = async (data) => {
    const temp = `${file}.${process.pid}.tmp`
    try {
      await writeFile(temp, JSON.stringify(data) + "\n", { mode: 0o600, flag: "wx" })
      await rename(temp, file)
    } finally { await rm(temp, { force: true }) }
  }
  // A cached read that is not `cached: true` is a remembered failure: it is
  // raised again as the error it was, not returned as a balance of zero.
  const remembered = (hit) => {
    if (!hit.failedAt) return hit
    throw Object.assign(new Error(hit.error), { remembered: true })
  }
  const hit = await cached()
  if (hit) return remembered(hit)
  if (pending.has(file)) return pending.get(file)
  const task = (async () => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    // One read at a time, across processes: magpie asks each account's row
    // separately, so a process of its own may already be reading. The wait is
    // the answer — a second read that overlapped would open a second browser
    // on the same Chrome profile and the two would fight over it.
    const release = await take(file, { busy: "Another process is still refreshing Vertex credits; retry shortly" })
    try {
      const again = await cached()
      if (again) return remembered(again)
      let result
      try {
        result = await scrape(settings)
      } catch (error) {
        await save({ error: error.message, failedAt: new Date().toISOString() })
        throw error
      }
      await save(result)
      return result
    } finally { await release() }
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
