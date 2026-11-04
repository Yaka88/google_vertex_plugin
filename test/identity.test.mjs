import "./network.mjs"
import assert from "node:assert/strict"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { adcDirectoryFor, knownAccounts, startLogin } from "../lib/credentials.mjs"
import { fakeGcloud } from "./gcloud.mjs"

async function fixture(t) {
  const gcloud = await fakeGcloud()
  const root = join(gcloud.directory, ".config", "gcp-ai")
  const originalFetch = globalThis.fetch
  const identities = new Map()
  const logins = []
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://openidconnect.googleapis.com/v1/userinfo")
    const identity = identities.get(init.headers.authorization.replace(/^Bearer /, ""))
    return { ok: Boolean(identity), json: async () => identity }
  }
  t.after(async () => {
    await Promise.all(logins.map((login) => login.close()))
    globalThis.fetch = originalFetch
    await gcloud.close()
  })
  const seed = async (email, token) => {
    const directory = adcDirectoryFor(email, root)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "application_default_credentials.json"), "{}")
    await writeFile(join(directory, ".fixture-account"), token)
    return directory
  }
  const start = async (options = {}) => {
    const login = await startLogin({ adcRoot: root, project: "example-project", ...options }, async () => ({
      ended: new Promise(() => {}), close: async () => {},
    }))
    logins.push(login)
    return login
  }
  const signIn = async (token, options = {}) => {
    await gcloud.set({ approved: token })
    return (await start(options)).result
  }
  const directories = async () => (await readdir(root)).filter((name) => name.startsWith("adc-")).sort()
  return { gcloud, root, identities, seed, start, signIn, directories }
}

for (const existingEmail of ["old@example.com", "new@example.com"]) {
  test(`same subject rejects a renamed login when the old ADC returns ${existingEmail}`, async (t) => {
    const f = await fixture(t)
    const oldDirectory = await f.seed("old@example.com", "old-token")
    f.identities.set("old-token", { email: existingEmail, sub: "stable-subject" })
    f.identities.set("new-token", { email: "new@example.com", sub: "stable-subject" })
    const result = await f.signIn("new-token", { account: "new@example.com" })
    assert.equal(result.project, undefined)
    assert.match(result.warning, /already signed in \(same Google subject\)/)
    assert.equal(await readFile(join(oldDirectory, "application_default_credentials.json"), "utf8"), "{}")
    assert.deepEqual(await f.directories(), ["adc-old-example-com"])
  })
}

test("same email with distinct subjects creates separate ADCs", async (t) => {
  const f = await fixture(t)
  const accounts = []
  for (const subject of ["Subject", "subject", "third-subject"]) {
    f.identities.set(subject, { email: "same@example.com", sub: subject })
    const result = await f.signIn(subject)
    assert.equal(result.project, "example-project")
    assert.equal(result.subject, subject)
    accounts.push(result)
  }
  // `sub` identifies the Google Account, compared exactly: three subjects are
  // three accounts even though they share one email label. The host account
  // key must be distinct too, or a later callback could overwrite the first.
  assert.equal(new Set(accounts.map((a) => a.cloudsdkConfig)).size, 3)
  assert.equal(new Set(accounts.map((a) => a.accountId)).size, 3)
  assert.equal(accounts[0].accountId, "same@example.com")
  assert.match(accounts[1].accountId, /^same@example\.com#[a-f0-9]{12}$/)
  assert.match(accounts[2].accountId, /^same@example\.com#[a-f0-9]{12}$/)
  for (const account of accounts) {
    assert.ok(await readFile(join(account.cloudsdkConfig, "application_default_credentials.json")))
  }
})

test("missing email or subject on a new login cannot register an incomplete account", async (t) => {
  const f = await fixture(t)
  for (const [token, identity] of Object.entries({
    "missing-sub": { email: "new@example.com" },
    "missing-email": { sub: "stable-subject" },
    "invalid-email": { sub: "stable-subject", email: "not-an-email" },
    "empty-userinfo": {},
  })) {
    f.identities.set(token, identity)
    const result = await f.signIn(token, { account: "new@example.com" })
    assert.match(result.warning, /email and subject could not be confirmed/)
    assert.deepEqual(await f.directories(), [])
  }
})

for (const unavailable of [true, false]) {
  test(`an existing ADC with ${unavailable ? "unavailable identity" : "missing subject"} blocks unverified registration`, async (t) => {
    const f = await fixture(t)
    const oldDirectory = await f.seed("old@example.com", "old-token")
    if (!unavailable) f.identities.set("old-token", { email: "old@example.com" })
    f.identities.set("new-token", { email: "new@example.com", sub: "new-subject" })
    const result = await f.signIn("new-token")
    assert.match(result.warning, /existing ADC's Google subject could not be confirmed/)
    assert.doesNotMatch(result.warning, /already signed in/)
    assert.equal(await readFile(join(oldDirectory, "application_default_credentials.json"), "utf8"), "{}")
    assert.deepEqual(await f.directories(), ["adc-old-example-com"])
  })
}

test("an email beginning with pending- remains discoverable while 0.1.1 adc-pending-* temp dirs are ignored", async (t) => {
  const f = await fixture(t)
  const legacyPending = join(f.root, "adc-pending-Ab12Cd")
  await mkdir(legacyPending, { recursive: true })
  await writeFile(join(legacyPending, "application_default_credentials.json"), "{}")
  const oldDirectory = await f.seed("pending-user@example.com", "old-token")
  f.identities.set("old-token", { email: "pending-user@example.com", sub: "stable-subject" })
  assert.deepEqual([...await knownAccounts({ adcRoot: f.root })], ["pending-user-example-com"])
  f.identities.set("new-token", { email: "renamed@example.com", sub: "stable-subject" })
  const result = await f.signIn("new-token", { account: "renamed@example.com" })
  assert.match(result.warning, /already signed in \(same Google subject\)/)
  assert.equal((await readFile(join(oldDirectory, "application_default_credentials.json"))).toString(), "{}")
  assert.deepEqual(await f.directories(), ["adc-pending-Ab12Cd", "adc-pending-user-example-com"])
})

test("an empty email-named directory is a storage collision, not a duplicate identity", async (t) => {
  const f = await fixture(t)
  const oldDirectory = adcDirectoryFor("same@example.com", f.root)
  await mkdir(oldDirectory, { recursive: true })
  await writeFile(join(oldDirectory, "keep"), "not-an-account")
  f.identities.set("new-token", { email: "same@example.com", sub: "new-subject" })
  const result = await f.signIn("new-token")
  assert.equal(result.project, "example-project")
  assert.notEqual(result.cloudsdkConfig, oldDirectory)
  assert.equal(await readFile(join(oldDirectory, "keep"), "utf8"), "not-an-account")
})

test("concurrent sign-ins register a subject only once", { timeout: 30000 }, async (t) => {
  const f = await fixture(t)
  f.identities.set("new-token", { email: "new@example.com", sub: "same-subject" })
  await f.gcloud.set({ approved: "new-token" })
  const logins = await Promise.all([f.start(), f.start()])
  const results = await Promise.all(logins.map((login) => login.result))
  assert.equal(results.filter((result) => result.project).length, 1)
  assert.match(results.find((result) => !result.project).warning, /same Google subject/)
  assert.deepEqual(await f.directories(), ["adc-new-example-com"])
})
