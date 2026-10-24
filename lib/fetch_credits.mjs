#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { closeKeptBrowsers, defaultProfile, openBrowser, routeAll } from "./browser.mjs"
import { accountOf, resolveIdentity, startLogin, tokenProvider } from "./credentials.mjs"
import { fetchCredits, parseCreditTables, readTables } from "./credits.mjs"
import { testEndpoint, summarize } from "./endpoint.mjs"
import { availableModels } from "./models.mjs"

export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? "credits"
  if (command === "help" || args.includes("--help")) {
    console.log("Usage: node lib/fetch_credits.mjs credits|credentials|login|models|endpoint|parse-html [--project ID] [--billing-account ID] [--profile PATH] [--cloudsdk-config DIR] [--force] [--headed] [--account EMAIL] [--auth-mode auto|gcloud|adc] [--location REGION] [--model ID] [--json] [--file HTML]")
    return
  }
  if (!["credits", "credentials", "login", "models", "endpoint", "parse-html"].includes(command)) throw new Error(`Unknown command: ${command}`)
  const valued = new Set(["--project", "--billing-account", "--profile", "--cloudsdk-config", "--account", "--auth-mode", "--file", "--location", "--model"])
  for (let i = 1; i < args.length; i++) {
    const option = args[i]
    if (valued.has(option)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${option} requires a value`)
      i++
    } else if (!["--force", "--headed", "--json"].includes(option)) throw new Error(`Unknown option: ${option}`)
  }
  const value = (name) => {
    const i = args.indexOf(name)
    if (i < 0) return undefined
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${name} requires a value`)
    return args[i + 1]
  }
  const options = {
    project: value("--project") ?? process.env.GOOGLE_VERTEX_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT,
    billingAccount: value("--billing-account") ?? process.env.VERTEX_BILLING_ACCOUNT,
    profile: value("--profile") ?? process.env.VERTEX_CHROME_PROFILE ?? defaultProfile(),
    account: value("--account") ?? process.env.VERTEX_GCLOUD_ACCOUNT,
    authMode: value("--auth-mode") ?? process.env.VERTEX_GCLOUD_AUTH_MODE,
    // Which ADC a command reads: a directory named here, else the plugin's own
    // for the account, else gcloud's default. The machine-wide CLOUDSDK_CONFIG
    // is deliberately not read: one variable would point every account at one
    // credential, and this plugin writes only its own directories.
    cloudsdkConfig: value("--cloudsdk-config"),
    location: value("--location") ?? process.env.GOOGLE_VERTEX_LOCATION ?? "global",
    force: args.includes("--force"), headless: !args.includes("--headed"),
  }
  if (command === "credits") {
    try {
      console.log(JSON.stringify(await fetchCredits(options), null, 2))
    } finally { await closeKeptBrowsers() }
  } else if (command === "credentials") {
    const identity = await resolveIdentity(options)
    const token = await tokenProvider(identity)()
    const account = identity.account ?? (identity.authMode === "adc" ? await accountOf(token) : undefined)
    console.log(JSON.stringify({ ...identity, ...(account ? { account } : {}), inferenceAuth: "token-verified" }, null, 2))
  } else if (command === "login") {
    console.error("Opening Chrome. If no Application Default Credentials exist yet, approving Google there also has gcloud write them.")
    const login = await startLogin(options)
    try {
      console.log(JSON.stringify({ ...await login.result, inferenceAuth: "token-verified" }, null, 2))
    } finally { await login.close() }
  } else if (command === "models") {
    console.log(JSON.stringify(await availableModels({ ...options, force: options.force }), null, 2))
  } else if (command === "endpoint") {
    // The models the row offers are what a real endpoint test should ask
    // about; --model narrows it to one when a single answer is wanted.
    const chosen = value("--model")
    const models = chosen ? [chosen] : (await availableModels(options).catch(() => ({ ids: [] }))).ids
    const report = await testEndpoint(options, { models })
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : summarize(report))
    if (!report.reachable) process.exitCode = 1
  } else if (command === "parse-html") {
    const file = value("--file")
    if (!file) throw new Error("parse-html requires --file PATH")
    const browser = await openBrowser({ profile: options.profile, headless: true, javaScriptEnabled: false })
    try {
      // The file is data, never code: scripts are stripped before it is parsed,
      // and every request it would make is refused.
      await routeAll(browser.page, () => undefined)
      const html = (await readFile(file, "utf8")).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      const encoded = Buffer.from(html).toString("base64")
      await browser.page.send("Page.navigate", { url: `data:text/html;base64,${encoded}` })
      await browser.page.waitForFunction(() => document.readyState !== "loading")
      console.log(JSON.stringify(parseCreditTables(await readTables(browser.page)), null, 2))
    } finally { await browser.close() }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1 })
}
