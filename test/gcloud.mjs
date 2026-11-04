import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// An executable fixture exercises the real subprocess boundary without touching
// the developer's gcloud configuration or making Google requests.
export async function fakeGcloud() {
  const directory = await mkdtemp(join(tmpdir(), "vertex-gcloud-test-"))
  const names = ["PATH", "HOME", "USERPROFILE", "VERTEX_TEST_GCLOUD", "GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "VERTEX_CHROME_PROFILE", "VERTEX_GCLOUD_ACCOUNT", "VERTEX_BILLING_ACCOUNT", "VERTEX_GCLOUD_AUTH_MODE", "GOOGLE_CLOUD_PROJECT", "CLOUDSDK_CONFIG", "GOOGLE_APPLICATION_CREDENTIALS", "XDG_CONFIG_HOME"]
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  const state = join(directory, "state.json")
  const log = join(directory, "calls.jsonl")
  // The plugin reads gcloud's default directory and never a machine-wide
  // CLOUDSDK_CONFIG, so the fixture moves HOME inside itself and lets both
  // sides meet at $HOME/.config/gcloud: the fake gcloud writes there, and so
  // does the plugin's own account directories stay out of it.
  const sdk = join(directory, ".config", "gcloud")
  // The fake runs on this test's own runtime, named by path: another
  // package's tests in the same run may leave PATH without node (grok's
  // nocli.mjs keeps only /usr/bin and /bin), and setup-node's node is not
  // there on CI.
  await writeFile(join(directory, "gcloud"), `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
const state = JSON.parse(readFileSync(process.env.VERTEX_TEST_GCLOUD, "utf8"))
const config = process.env.CLOUDSDK_CONFIG || join(process.env.HOME, ".config", "gcloud")
const args = process.argv.slice(2)
appendFileSync(state.log, JSON.stringify(args) + "\\n")
if (state.fail) { process.stderr.write("SECRET-ERROR-OUTPUT"); process.exit(1) }
// A token belongs to the account whose ADC is in the directory it is read
// from. An ADC login writes that account beside the file it writes, so the
// token still names the right account after the directory is renamed.
const written = (() => {
  try { return readFileSync(config + "/.fixture-account", "utf8").trim() } catch { return undefined }
})()
// ADC's token command fails when the directory holds no ADC, as gcloud's does.
// A gcloud-user token (--account=...) does not depend on ADC.
const hasAdc = (() => {
  try { readFileSync(config + "/application_default_credentials.json"); return true } catch { return false }
})()
if (args[0] === "config") console.log(state[args[2]] ?? "(unset)")
else if (args.includes("print-access-token")) {
  if (!args.some((arg) => arg.startsWith("--account=")) && !hasAdc) { process.stderr.write("no ADC in this directory"); process.exit(1) }
  console.log(written ?? state.tokens?.[config] ?? state.token ?? "fixture-token")
}
// An ADC login is gcloud's own: the fixture only writes the file, into the
// directory it was pointed at, as the real one does.
else if (args[0] === "auth" && args[1] === "application-default" && args[2] === "login") {
  const { mkdirSync, writeFileSync } = await import("node:fs")
  // state.approved is who Google's consent page is approved as, which the
  // address the plugin opened asks for as authuser.
  const approved = state.approved?.[config] ?? state.approved ?? state.pendingToken
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "secret", refresh_token: "refresh", approved }))
  // Who this directory's token now belongs to. It travels with the directory,
  // as gcloud's credentials do, so a rename does not change the answer.
  if (approved) writeFileSync(join(config, ".fixture-account"), approved)
  process.stderr.write("Your browser has been opened to visit:\\n\\n    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x&state=y\\n\\n")
  process.exit(0)
}
else process.exit(2)
`, { mode: 0o700 })
  process.env.PATH = `${directory}:${process.env.PATH}`
  process.env.VERTEX_TEST_GCLOUD = state
  // From VERTEX_TEST_GCLOUD on: the plugin's own variables, never the fixture's state path.
  for (const name of names.slice(4)) delete process.env[name]
  process.env.HOME = directory
  delete process.env.USERPROFILE
  // Keep ADC discovery inside the fixture: the developer's own ADC file must
  // never decide a test's auth mode.
  const set = (values = {}) => writeFile(state, JSON.stringify({ project: "example-project", account: "user@example.com", log, ...values }))
  await set()
  return {
    directory, set, sdk,
    async setAdc(values = { quota_project_id: "adc-project" }) {
      await mkdir(sdk, { recursive: true })
      await writeFile(join(sdk, "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "secret", refresh_token: "refresh", ...values }))
    },
    async clearAdc() { await rm(join(sdk, "application_default_credentials.json"), { force: true }) },
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
