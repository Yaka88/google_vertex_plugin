import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// An executable fixture exercises the real subprocess boundary without touching
// the developer's gcloud configuration or making Google requests.
export async function fakeGcloud() {
  const directory = await mkdtemp(join(tmpdir(), "vertex-gcloud-test-"))
  const names = ["PATH", "VERTEX_TEST_GCLOUD", "GOOGLE_VERTEX_PROJECT", "VERTEX_GCLOUD_ACCOUNT", "VERTEX_BILLING_ACCOUNT", "VERTEX_GCLOUD_AUTH_MODE", "GOOGLE_CLOUD_PROJECT", "CLOUDSDK_CONFIG", "GOOGLE_APPLICATION_CREDENTIALS"]
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  const state = join(directory, "state.json")
  const log = join(directory, "calls.jsonl")
  await writeFile(join(directory, "gcloud"), `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs"
const state = JSON.parse(readFileSync(process.env.VERTEX_TEST_GCLOUD, "utf8"))
const args = process.argv.slice(2)
appendFileSync(state.log, JSON.stringify(args) + "\\n")
if (state.fail) { process.stderr.write("SECRET-ERROR-OUTPUT"); process.exit(1) }
if (args[0] === "config") console.log(state[args[2]] ?? "(unset)")
else if (args.includes("print-access-token")) console.log(state.tokens?.[process.env.CLOUDSDK_CONFIG] ?? state.token ?? "fixture-token")
// An ADC login is gcloud's own: the fixture only writes the file, into the
// directory it was pointed at, as the real one does.
else if (args[0] === "auth" && args[1] === "application-default" && args[2] === "login") {
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  // state.approved is who Google's consent page is approved as, which the
  // address the plugin opened asks for as authuser.
  const approved = state.approved?.[process.env.CLOUDSDK_CONFIG] ?? state.approved
  mkdirSync(process.env.CLOUDSDK_CONFIG, { recursive: true })
  writeFileSync(join(process.env.CLOUDSDK_CONFIG, "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "secret", refresh_token: "refresh", approved }))
}
else process.exit(2)
`, { mode: 0o700 })
  process.env.PATH = `${directory}:${process.env.PATH}`
  process.env.VERTEX_TEST_GCLOUD = state
  for (const name of names.slice(2)) delete process.env[name]
  // Keep ADC discovery inside the fixture: the developer's own ADC file must
  // never decide a test's auth mode.
  process.env.CLOUDSDK_CONFIG = join(directory, "cloudsdk")
  // tokens names the token each config directory answers with, so a test can
  // give two accounts' ADCs two different identities.
  const set = (values = {}) => writeFile(state, JSON.stringify({ project: "example-project", account: "user@example.com", log, ...values }))
  await set()
  return {
    directory, set,
    async setAdc(values = { quota_project_id: "adc-project" }) {
      await mkdir(process.env.CLOUDSDK_CONFIG, { recursive: true })
      await writeFile(join(process.env.CLOUDSDK_CONFIG, "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "secret", refresh_token: "refresh", ...values }))
    },
    async clearAdc() { await rm(join(process.env.CLOUDSDK_CONFIG, "application_default_credentials.json"), { force: true }) },
    async calls() { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse) },
    async close() {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(directory, { recursive: true, force: true })
    },
  }
}
