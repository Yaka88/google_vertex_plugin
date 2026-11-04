import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { assertConsoleSession, cacheRoot, defaultProfile, expandPath, extractConsoleIdentity, safeGoto, validateBillingAccount, validateProfileDirectory, validateProject, withPage } from "./browser.mjs"
import { take } from "./lock.mjs"
import { effectiveAuthMode, resolveProject, validateAccount } from "./credentials.mjs"

const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim()
// Failures that say something about the network at this moment rather than
// about the account: they are remembered for a minute, not twenty.
const NETWORK_FAILURE = /ERR_(?:TIMED_OUT|CONNECTION|NETWORK|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|PROXY|TUNNEL|SSL|EMPTY_RESPONSE)|net::ERR_|timed out after|TimeoutError|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i
const column = (headers, name) => headers.findIndex((h) => normalize(h).toLowerCase() === name)
// The currencies a credit can be read in. A billing account is read in USD
// unless billingCurrencies names another one for it: the Console writes yen
// and yuan with the same ¥, so a currency is never guessed from a symbol
// (kidchen94, #667). Amounts are kept in the currency's minor unit and
// nothing is ever converted.
export const CURRENCIES = {
  USD: { digits: 2, symbol: "$", marks: ["US$", "$"] },
  JPY: { digits: 0, symbol: "¥", marks: ["JP¥", "¥", "￥"] },
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// What an amount looks like in a currency, for telling the person which one
// the page shows when it isn't the one the billing account is read in.
const looksLike = (text) => {
  if (/^(?:JP¥|JPY\b)|\bJPY$/.test(text)) return "JPY"
  if (/^(?:US\$|USD\b)|\bUSD$/.test(text)) return "USD"
  if (/^[¥￥]/.test(text)) return "¥"
  if (/^\$/.test(text)) return "USD"
}
const money = (value, currency = "USD", billingAccount) => {
  const text = normalize(value)
  const { digits, marks } = CURRENCIES[currency]
  const mark = `(?:${marks.map(escape).join("|")}|${currency}\\s*)`
  const number = `(\\d{1,3}(?:,\\d{3})+|\\d+)${digits ? `(?:\\.(\\d{${digits}}))?` : ""}`
  const match = new RegExp(`^${mark}${number}(?:\\s*${currency})?$`).exec(text) ?? new RegExp(`^${number}\\s*${currency}$`).exec(text)
  if (!match) {
    const seen = looksLike(text)
    const which = billingAccount ? `billing account ${billingAccount}` : "this billing account"
    const set = (code) => `set billingCurrencies to { "${billingAccount ?? "<billing account>"}": "${code}" }`
    // A ¥ under JPY is yen written wrongly (a fraction, a bad grouping), not
    // another currency.
    if (seen && seen !== currency && !(seen === "¥" && CURRENCIES[currency].marks.includes("¥"))) {
      throw new Error(seen === "¥"
        ? `Credits read for ${which} are in ¥ (yen or yuan), not ${currency}. If it bills in Japanese yen, ${set("JPY")} in the gcp-ai options; other currencies are not supported`
        : `Credits read for ${which} are in ${seen}, not ${currency}; ${set(seen)} in the gcp-ai options`)
    }
    throw new Error(`Unsupported credit amount/currency: ${text} (${which} is read in ${currency}; supported: ${Object.keys(CURRENCIES).join(", ")})`)
  }
  return Number(match[1].replaceAll(",", "")) * 10 ** digits + Number(match[2] ?? 0)
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
export function parseCreditTables(tables, { now = Date.now(), currency = "USD", billingAccount } = {}) {
  if (!CURRENCIES[currency]) throw new Error(`Unsupported billing currency ${currency}; supported: ${Object.keys(CURRENCIES).join(", ")}`)
  const unit = 10 ** CURRENCIES[currency].digits
  const credits = new Map()
  let recognized = false
  const unread = []
  // A credit's status is a small vocabulary that Google grows over time: a
  // credit that reads "Active" a month before its end date reads "Expiring in
  // 24 days" in the month of it. That wording is a fact about time rather
  // than about the money, so it is recognized as the state it means (still
  // spendable, with the end date deciding eligibility) instead of being
  // refused as a status this parser has never seen. "Expired" stays a
  // different state.
  const spent = ["exhausted", "used up", "used"]
  const usable = ["available", "active", ...spent]
  const known = [...usable, "expired", "pending"]
  for (const table of tables) {
    const headers = table.headers.map(normalize)
    const indices = Object.fromEntries(["credit name", "status", "remaining value", "original value", "credit id", "start date", "end date", "usage scope"].map((name) => [name, column(headers, name)]))
    if (["credit name", "status", "remaining value", "original value", "credit id"].some((name) => indices[name] < 0)) {
      if (headers.filter(Boolean).length >= 3 && table.rows?.length) unread.push(headers.filter(Boolean))
      continue
    }
    recognized = true
    for (const row of table.rows) {
      const cell = (name) => normalize(row[indices[name]])
      const status = cell("status").toLowerCase()
      const expiring = /^(?:expiring|expires)\b/.test(status)
      if (!known.includes(status) && !expiring) throw new Error(`Unknown Google Cloud credit status: ${cell("status")}`)
      const id = cell("credit id")
      if (!id || credits.has(id)) continue
      const reported = money(cell("remaining value"), currency, billingAccount)
      const original = money(cell("original value"), currency, billingAccount)
      if (!Number.isSafeInteger(reported) || !Number.isSafeInteger(original) || reported < 0 || reported > original) throw new Error("Invalid Google Cloud credit amounts")
      const remaining = spent.includes(status) ? 0 : reported
      const start = isoDate(cell("start date"))
      const end = isoDate(cell("end date"))
      const eligible = (usable.includes(status) || expiring) && !(start && Date.parse(start) > now) && !(end && Date.parse(end) <= now)
      credits.set(id, { id, name: cell("credit name"), status: cell("status"), remaining: remaining / unit, original: original / unit, start, end, scope: cell("usage scope"), eligible })
    }
  }
  // A table with rows whose columns aren't the English ones is a page in
  // another language (Chrome's translation, or a Console that ignored hl=en),
  // not a lapsed session: say what was there.
  if (!recognized && unread.length) {
    throw new Error(`The Cloud Console credits table's columns are not the English ones this plugin reads (it found: ${unread[0].slice(0, 6).join(", ")}); the page may have been translated or shown in another language. Turn off translation for console.cloud.google.com in the plugin's Chrome profile and retry`)
  }
  if (!recognized || !credits.size) throw new Error("Google Cloud Credits table was not found or is empty; the session may be expired, the page may still be loading, or its layout changed")
  const active = [...credits.values()].filter((credit) => credit.eligible)
  const remaining = active.reduce((sum, credit) => sum + Math.round(credit.remaining * unit), 0)
  const original = active.reduce((sum, credit) => sum + Math.round(credit.original * unit), 0)
  const ends = active.filter((credit) => credit.remaining > 0 && credit.end).map((credit) => credit.end).sort()
  const soonest = ends[0]
  return {
    currency, remaining: remaining / unit, original: original / unit, used: (original - remaining) / unit,
    usedPercent: original > 0 ? ((original - remaining) * 100) / original : 100,
    ...(soonest ? { runsOutAt: soonest, runsOut: active.filter((c) => c.end === soonest).reduce((s, c) => s + Math.round(c.remaining * unit), 0) / unit } : {}),
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
  if (accounts.length !== 1) {
    throw new Error(`Cannot tell which billing account project ${project} uses (the Console showed ${accounts.length ? accounts.join(", ") : "none"}); set billingAccounts to { "${project}": "<billing account>" } in the gcp-ai options`)
  }
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
async function confirmAccount(page, account, subject) {
  if (!account && !subject) return
  const identity = await extractConsoleIdentity(page, { timeout: 8000 })
  const shown = identity.account
  if (identity.conflict) throw new Error("Cloud Console returned conflicting account identity fields; refusing to report credits")
  // Google userinfo can retain the old email while Console shows the renamed
  // address. A matching page subject establishes identity despite that label.
  // A different subject must be rejected even when the emails happen to match.
  if (subject && identity.subject) {
    if (identity.subject !== subject) throw new Error("Cloud Console is signed in to a different Google account (subject mismatch); refusing to report credits")
    return identity
  }
  // A page that never named an account is not evidence that it named this one.
  // A fallback to another authuser is exactly what the check is for, and it is
  // silent: the URL still says this account while the page is another person's.
  if (!shown || !account) throw new Error("Cloud Console did not show which account the credits belong to with a verifiable identity; refusing to report a balance that may be another account's")
  if (shown.toLowerCase() !== account.toLowerCase()) {
    throw new Error(`Cloud Console is signed in as ${shown}, not ${account}; sign in as ${account} in the Chrome profile and retry`)
  }
  return { account: shown }
}

export function consoleAccountFor(account, aliases) {
  if (aliases === undefined) return account
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    throw new Error("consoleAccountAliases must be an object mapping saved account emails to current Console emails")
  }
  // Normalize both sides once so renamed emails and case differences select
  // the same Console session without changing the saved credential account.
  const normalized = new Map()
  for (const [saved, current] of Object.entries(aliases)) {
    const key = validateAccount(saved).toLowerCase()
    const value = validateAccount(current).toLowerCase()
    if (normalized.has(key)) throw new Error(`Duplicate consoleAccountAliases entry for ${key}`)
    normalized.set(key, value)
  }
  if (!normalized.size) return account
  if (!account) throw new Error("consoleAccountAliases requires a saved account email")
  return normalized.get(validateAccount(account).toLowerCase()) ?? account
}

// The per-account and per-project maps a machine with several Google
// accounts needs, since one machine-wide variable would point every account at
// one value: which billing account a project's credits are read from, which
// currency a billing account bills in, and which Chrome profile directory
// holds an account's Console session.
function readMap(name, value, key, entry) {
  const map = new Map()
  if (value === undefined || value === null) return map
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  for (const [k, v] of Object.entries(value)) {
    let parsed
    try { parsed = [key(k), entry(v)] } catch (error) { throw new Error(`${name}: ${error.message}`) }
    if (map.has(parsed[0])) throw new Error(`Duplicate ${name} entry for ${parsed[0]}`)
    map.set(...parsed)
  }
  return map
}
const billingAccountsOf = (value) => readMap("billingAccounts", value, (project) => validateProject(project), (account) => validateBillingAccount(account).toUpperCase())
export const billingCurrenciesOf = (value) => readMap("billingCurrencies", value, (account) => validateBillingAccount(account).toUpperCase(), (currency) => {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : ""
  if (!CURRENCIES[code]) throw new Error(`${JSON.stringify(currency)} is not a currency this plugin reads (${Object.keys(CURRENCIES).join(", ")})`)
  return code
})
const profileDirectoriesOf = (value) => readMap("profileDirectories", value, (account) => validateAccount(account).toLowerCase(), (directory) => {
  const name = validateProfileDirectory(directory)
  if (!name) throw new Error("a profile directory cannot be empty")
  return name
})
const currencyOf = (currencies, billingAccount) => currencies.get(String(billingAccount ?? "").toUpperCase()) ?? "USD"

// Chrome marks a page it translated on its root element. Such a page's table
// is words Chrome chose, not the Console's: it is never parsed.
const TRANSLATED = "The Cloud Console page was translated by Chrome, so its credits table can't be read; turn off translation for console.cloud.google.com in the plugin's Chrome profile and retry"
const translated = (page) => page.evaluate(() => location.origin === "https://console.cloud.google.com" && /\btranslated-(?:ltr|rtl)\b/.test(document.documentElement?.className ?? ""))

async function readPage(page, options) {
  // How long the Console is given to show the credits table. The first wait is
  // only a hint that the page has started answering: what decides the read is
  // assertConsoleSession below (which says a lapsed session is a lapsed
  // session) and the table's own wait, whose timeout is the failure to report.
  const wait = (fallback) => (Number(options.scrapeTimeout) > 0 ? Math.min(Number(options.scrapeTimeout), fallback) : fallback)
  const consoleAccount = options.consoleAccount
  const account = options.billingAccount ? validateBillingAccount(options.billingAccount) : await discoverBillingAccount(page, options.project, consoleAccount)
  const source = `https://console.cloud.google.com/billing/${account}/credits/all?hl=en${consoleAccount ? `&authuser=${encodeURIComponent(consoleAccount)}` : ""}`
  const currency = currencyOf(options.currencies ?? billingCurrenciesOf(options.billingCurrencies), account)
  await safeGoto(page, source)
  await page.waitForFunction(() => location.hostname === "accounts.google.com" || /\btranslated-(?:ltr|rtl)\b/.test(document.documentElement?.className ?? "") || [...document.querySelectorAll("th, [role='columnheader']")].some((cell) => cell.innerText.trim() === "Remaining value"), undefined, { timeout: wait(45000) }).catch(() => {})
  if (await translated(page)) throw new Error(TRANSLATED)
  await assertConsoleSession(page, { timeout: wait(20000) })
  // The table is the read: a page that never shows one is not a balance, and
  // the error says which of the two waits ran out. A row is ready when its
  // cells hold a number, in whatever currency: waiting for a "$" left a yen
  // account waiting out the whole timeout before its currency was named.
  await page.waitForFunction(() => /\btranslated-(?:ltr|rtl)\b/.test(document.documentElement?.className ?? "")
    || [...document.querySelectorAll("tbody tr, [role='row']")].some((row) => row.querySelector("td, [role='gridcell'], [role='cell']") && /\d/.test(row.innerText)), undefined, { timeout: wait(30000) })
    .catch(() => { throw new Error("Google Cloud Credits table was not found or is empty; the session may be expired, the page may still be loading, or its layout changed") })
  if (await translated(page)) throw new Error(TRANSLATED)
  const confirmed = await confirmAccount(page, consoleAccount, options.googleSubject)
  const tables = []
  const seen = new Set()
  for (let index = 0; index < 100; index++) {
    const next = await readTables(page)
    const signature = JSON.stringify(next)
    if (seen.has(signature)) throw new Error("Credits pagination did not advance; refusing an incomplete balance")
    seen.add(signature)
    tables.push(...next)
    if (!(await nextPage(page))) return {
      ...parseCreditTables(tables, { currency, billingAccount: account }), billingAccount: account, source,
      ...(confirmed?.subject ? { googleSubject: confirmed.subject, consoleAccount: confirmed.account } : {}),
    }
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
  return withPage({ profile: options.profile, profileDirectory: options.profileDirectory, headless: options.headless ?? true }, (page) => readPage(page, options))
}

const pending = new Map()

export async function fetchCredits(options = {}) {
  const billingAccounts = billingAccountsOf(options.billingAccounts)
  const currencies = billingCurrenciesOf(options.billingCurrencies)
  const profileDirectories = profileDirectoriesOf(options.profileDirectories)
  const project = options.project ?? process.env.GOOGLE_VERTEX_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT
  const settings = {
    ...options,
    profile: options.profile ?? process.env.VERTEX_CHROME_PROFILE ?? defaultProfile(),
    project,
    // The project's own entry beats a row-wide or machine-wide account.
    billingAccount: (project && billingAccounts.get(project)) ?? options.billingAccount ?? process.env.VERTEX_BILLING_ACCOUNT,
    account: options.account ?? process.env.VERTEX_GCLOUD_ACCOUNT,
    currencies,
  }
  if (settings.billingAccount) validateBillingAccount(settings.billingAccount)
  else {
    settings.project = await resolveProject(settings, undefined, await effectiveAuthMode(settings))
    if (settings.project && billingAccounts.has(settings.project)) settings.billingAccount = billingAccounts.get(settings.project)
  }
  if (settings.project) validateProject(settings.project)
  if (settings.account) validateAccount(settings.account)
  const mapped = consoleAccountFor(settings.account, settings.consoleAccountAliases)
  settings.consoleAccount = mapped?.toLowerCase() !== settings.account?.toLowerCase()
    ? mapped : settings.consoleAccount || mapped
  if (settings.consoleAccount) validateAccount(settings.consoleAccount)
  settings.profileDirectory = validateProfileDirectory(
    profileDirectories.get(settings.account?.toLowerCase()) ?? profileDirectories.get(settings.consoleAccount?.toLowerCase())
    ?? options.profileDirectory ?? process.env.VERTEX_CHROME_PROFILE_DIRECTORY,
  )
  // The Chrome profile alone does not tell two Google accounts apart: one
  // profile can hold both, so each read also names the account whose cookies
  // it used (and, when it has one, that account's own ADC directory).
  const identityParts = [expandPath(settings.profile), settings.project ?? "", settings.billingAccount ?? "", settings.account ?? "", settings.cloudsdkConfig ?? ""]
  // Preserve existing caches unless an alias changes the selected Console
  // session; an old email-mismatch error must not block the renamed account.
  if (settings.consoleAccount?.toLowerCase() !== settings.account?.toLowerCase()) identityParts.push(settings.consoleAccount)
  // A subject-verified request must not reuse legacy email-only balances or
  // mismatch failures. Include the subject and validation version in its key.
  if (settings.googleSubject) identityParts.push({ googleSubject: settings.googleSubject, identityVersion: 2 })
  // Another Chrome profile is another session, and another currency another
  // reading of the same page: neither may reuse what the other cached. Added
  // only when set, so the caches of reads that set neither are kept.
  if (settings.profileDirectory) identityParts.push({ profileDirectory: settings.profileDirectory })
  if (currencies.size) identityParts.push({ currencies: [...currencies].sort(([a], [b]) => a.localeCompare(b)) })
  const identity = JSON.stringify(identityParts)
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
    let data
    try {
      data = JSON.parse(await readFile(file, "utf8"))
    } catch {
      return undefined
    }
    if (data.googleSubject && data.googleSubject !== settings.googleSubject) {
      throw new Error("Cached Google Cloud credits identify a different Google account; refusing to report that balance")
    }
    const age = Date.now() - Date.parse(data.failedAt ?? data.fetchedAt)
    if (settings.force || !(age >= 0)) return undefined
    if (data.failedAt) return age < (transient(data) ? transientTtl : failureTtl) * 1000 ? { ...data, cached: false } : undefined
    const futureExpiry = !data.runsOutAt || Date.parse(data.runsOutAt) > Date.now()
    if (age < ttl * 1000 && futureExpiry && data.currency === currencyOf(currencies, data.billingAccount ?? settings.billingAccount) && Number.isFinite(data.remaining) && Number.isFinite(data.original) && Number.isFinite(data.usedPercent)) return { ...data, cached: true }
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
  const currency = CURRENCIES[credits.currency] ? credits.currency : "USD"
  const { digits, symbol } = CURRENCIES[currency]
  const amount = (value) => `${symbol}${value.toFixed(digits)}`
  return {
    plan: "Google Cloud promotional credits", balance: `${amount(credits.remaining)} ${currency}`, signIn: "kept",
    windows: [{
      name: "Promotional Credits", used: credits.usedPercent,
      display: `${amount(credits.remaining)} remaining / ${amount(credits.original)} ${currency}${credits.cached ? " (cached)" : ""}`,
      amount: credits.used, limit: credits.original, unit: currency,
      ...(credits.runsOutAt ? { runsOutAt: credits.runsOutAt, runsOut: credits.runsOut } : {}),
    }],
  }
}
