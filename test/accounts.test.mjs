import "./network.mjs"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import plugin from "../index.mjs"
import { adcDirectoryFor, identityOf } from "../lib/credentials.mjs"
import { fakeGcloud } from "./gcloud.mjs"

// A Google Account whose email changed keeps its `sub`: Google documents `sub`
// as "unique among all Google Accounts and never reused" and says "a Google
// Account can have multiple email addresses at different points in time, but
// the sub value is never changed" (OpenID Connect, ID token claims). These
// tests pin how usage() reads quota for such an account.

const billingAccount = "AAAAAA-BBBBBB-CCCCCC"

async function fixture(t, mode = "adc") {
  const gcloud = await fakeGcloud()
  const originalFetch = globalThis.fetch
  const cache = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = join(gcloud.directory, "cache")
  t.after(async () => {
    globalThis.fetch = originalFetch
    if (cache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = cache
    await gcloud.close()
  })
  const directory = adcDirectoryFor("old@example.com")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "application_default_credentials.json"), "{}")
  const profile = join(gcloud.directory, "profile")
  const saved = {
    type: "oauth", authMode: mode, accountId: "old@example.com", project: "example-project",
    cloudsdkConfig: directory, profile, billingAccount, access: "", refresh: "", expires: 0,
  }
  let auth = saved
  const writes = []
  const hooks = await plugin({ client: { auth: { set: async (value) => {
    writes.push(value)
    auth = value.body
  } } } })
  // A cached balance proves which Console identity and ADC directory the
  // public usage hook selected, without starting Chrome or contacting Google.
  // credentialAccount is the account the read is made with (the record's
  // credentialAccount or accountId); the cache key names it.
  async function balance(account, remaining = 7, failed = false, subject = "google-user-1", identity = {}, credentialAccount = saved.accountId, original = 10) {
    // null: a record with no credential account yet (an unnamed sign-in).
    const parts = [profile, saved.project, billingAccount, credentialAccount ?? "", directory]
    if (account !== (credentialAccount ?? undefined)) parts.push(account)
    if (subject) parts.push({ googleSubject: subject, identityVersion: 2 })
    const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24)
    const file = join(process.env.XDG_CACHE_HOME, "magpie", "gcp-ai", `credits-${digest}.json`)
    await mkdir(join(process.env.XDG_CACHE_HOME, "magpie", "gcp-ai"), { recursive: true })
    await writeFile(file, JSON.stringify(failed
      ? { error: "old cached email mismatch", failedAt: new Date().toISOString() }
      : { currency: "USD", remaining, original, used: original - remaining, usedPercent: ((original - remaining) * 100) / original, fetchedAt: new Date().toISOString(), ...identity }))
  }
  return { gcloud, hooks, writes, saved, directory, balance, getAuth: async () => auth, replace: (value) => { auth = value } }
}

const userinfo = (body) => async () => ({ ok: true, json: async () => body })

test("a renamed account exposes its promotional-credit window to the host", async (t) => {
  const f = await fixture(t)
  f.replace({ ...f.saved, googleSubject: "google-user-1", credentialAccount: "old@example.com", consoleAccount: "old@example.com" })
  globalThis.fetch = userinfo({ sub: "google-user-1", email: "old@example.com" })
  await f.balance("old@example.com", 85.43, false, "google-user-1", {
    googleSubject: "google-user-1", consoleAccount: "new@example.com",
  }, f.saved.accountId, 100)

  const usage = await f.hooks.auth.usage(f.getAuth)
  assert.equal(usage.error, undefined)
  assert.equal(usage.user, "new@example.com")
  assert.equal(usage.balance, "$85.43 USD")
  const window = usage.windows[0]
  assert.equal(window.name, "Promotional Credits")
  assert.ok(Math.abs(window.used - 14.57) < 0.001)
  assert.match(window.display, /^\$85\.43 remaining \/ \$100\.00 USD(?: \(cached\))?$/)
  assert.ok(Math.abs(window.amount - 14.57) < 0.001)
  assert.equal(window.limit, 100)
  assert.equal(window.unit, "USD")
})

test("userinfo keeps stable identity claims from successful responses", async () => {
  assert.deepEqual(await identityOf("test-token", userinfo({ sub: "google-user-1", email: "new@example.com" })),
    { subject: "google-user-1", account: "new@example.com" })
  assert.deepEqual(await identityOf("test-token", userinfo({ sub: "google-user-1" })), { subject: "google-user-1" })
  assert.deepEqual(await identityOf("test-token", userinfo({})), {})
  assert.equal(await identityOf("test-token", async () => ({ ok: false })), undefined)
})

test("login callback saves the Google subject before the first quota refresh", async (t) => {
  const f = await fixture(t)
  globalThis.fetch = userinfo({ sub: "google-user-1", email: "new@example.com" })
  // Pinned ADC exercises the real authorize/callback path without opening
  // Chrome or creating another credential for the fixture account.
  await f.hooks.config({ provider: { "gcp-ai": { options: {
    authMode: "adc", cloudsdkConfig: f.directory, project: f.saved.project,
  } } } })
  const authorization = await f.hooks.auth.methods[0].authorize()
  const result = await authorization.callback()
  assert.equal(result.type, "success")
  assert.equal(result.accountId, "new@example.com")
  assert.equal(result.googleSubject, "google-user-1")
  assert.equal(result.cloudsdkConfig, f.directory)
  assert.equal(f.writes.length, 0, "login returns a record for the host; it does not refresh quota")
  f.replace({ ...result, type: "oauth" })
  globalThis.fetch = userinfo({ sub: "another-google-user", email: "new@example.com" })
  const usage = await f.hooks.auth.usage(f.getAuth)
  assert.match(usage.error, /no longer identify the saved account/)
  assert.equal(f.writes.length, 0, "even the first quota refresh must reject another subject")
})

for (const mode of ["adc", "gcloud"]) {
  test(`${mode}: after a rename, quota is read for the new email under the unchanged Magpie account`, async (t) => {
    const f = await fixture(t, mode)
    const asked = []
    globalThis.fetch = async (url, init) => {
      asked.push([url, init.headers.authorization])
      return { ok: true, json: async () => ({ sub: "google-user-1", email: "new@example.com" }) }
    }
    // An email-only failure cached for the old address must not block the
    // renamed account; the subject-keyed read for the new address is used.
    await f.balance("old@example.com", 1, true, null)
    await f.balance("new@example.com")
    const usage = await f.hooks.auth.usage(f.getAuth)
    assert.equal(usage.error, undefined)
    assert.equal(usage.balance, "$7.00 USD")
    assert.equal(usage.user, "new@example.com", "the new email is shown through usage().user")
    assert.equal(f.writes.length, 0, "usage must not persist a derived identity through a non-conditional host write")
    assert.deepEqual(await f.getAuth(), f.saved, "the Magpie account key and auth record remain unchanged")
    assert.equal((await f.hooks.auth.usage(f.getAuth)).balance, "$7.00 USD")
    assert.equal(f.writes.length, 0, "repeated usage reads must not rewrite host authentication")
    assert.equal(asked.length, 2)
    assert.ok(asked.every(([url]) => url === "https://openidconnect.googleapis.com/v1/userinfo"))
    // gcloud keeps a renamed account's credentials under the address it was
    // signed in with, so the credential selector never follows the rename.
    const calls = (await f.gcloud.calls()).filter((args) => args.includes("print-access-token"))
    assert.ok(calls.every((args) => mode === "adc" ? args.includes("application-default") : args.includes("--account=old@example.com")))
  })
}

test("an unnamed sign-in remains readable without a non-conditional auth write", async (t) => {
  const f = await fixture(t)
  f.replace({ ...f.saved, accountId: undefined })
  globalThis.fetch = userinfo({ sub: "google-user-1", email: "old@example.com" })
  // This first read has no credential account yet: the cache key says so.
  await f.balance("old@example.com", 7, false, "google-user-1", {}, null)
  const usage = await f.hooks.auth.usage(f.getAuth)
  assert.equal(usage.error, undefined)
  assert.equal((await f.getAuth()).accountId, undefined)
  assert.equal((await f.hooks.auth.usage(f.getAuth)).user, "old@example.com")
  assert.equal(f.writes.length, 0)
})

test("an unavailable userinfo service keeps the last confirmed Console email", async (t) => {
  const f = await fixture(t)
  f.replace({ ...f.saved, googleSubject: "google-user-1", consoleAccount: "new@example.com" })
  globalThis.fetch = async () => { throw new Error("offline") }
  await f.balance("new@example.com")
  const usage = await f.hooks.auth.usage(f.getAuth)
  assert.equal(usage.balance, "$7.00 USD")
  assert.equal(usage.user, "new@example.com")
  assert.equal(f.writes.length, 0)
})

test("Console can confirm a new email by subject while userinfo keeps returning the old one", async (t) => {
  const f = await fixture(t)
  const initial = { ...f.saved, googleSubject: "google-user-1", credentialAccount: "old@example.com", consoleAccount: "old@example.com" }
  f.replace(initial)
  globalThis.fetch = userinfo({ sub: "google-user-1", email: "old@example.com" })
  const identity = { googleSubject: "google-user-1", consoleAccount: "new@example.com" }
  await f.balance("old@example.com", 7, false, "google-user-1", identity)
  const usage = await f.hooks.auth.usage(f.getAuth)
  assert.equal(usage.error, undefined)
  assert.equal(usage.user, "new@example.com")
  assert.equal(usage.balance, "$7.00 USD")
  assert.deepEqual(await f.getAuth(), initial, "Console display identity is returned without rewriting the host auth record")
  // Later polls select the verified Console address; userinfo's older email
  // does not overwrite it, and nothing is rewritten again.
  await f.balance("new@example.com", 7, false, "google-user-1", identity)
  assert.equal((await f.hooks.auth.usage(f.getAuth)).user, "new@example.com")
  assert.equal(f.writes.length, 0)
  globalThis.fetch = async () => { throw new Error("offline") }
  assert.equal((await f.hooks.auth.usage(f.getAuth)).user, "new@example.com")
  assert.equal(f.writes.length, 0)
})

test("a Console page of another subject is never taken as this account's new email", async (t) => {
  const f = await fixture(t)
  f.replace({ ...f.saved, googleSubject: "google-user-1", credentialAccount: "old@example.com", consoleAccount: "old@example.com" })
  globalThis.fetch = userinfo({ sub: "google-user-1", email: "old@example.com" })
  await f.balance("old@example.com", 7, false, "google-user-1", { googleSubject: "google-user-2", consoleAccount: "other@example.com" })
  const usage = await f.hooks.auth.usage(f.getAuth)
  assert.match(usage.error, /Cached Google Cloud credits identify a different Google account/)
  assert.equal(usage.balance, undefined)
  assert.equal(usage.windows, undefined)
  assert.notEqual(usage.user, "other@example.com")
  assert.equal((await f.getAuth()).consoleAccount, "old@example.com")
  assert.equal(f.writes.length, 0)
})

test("a replacement during credits retrieval cannot inherit the old account's label or balance", async (t) => {
  const f = await fixture(t)
  f.replace({ ...f.saved, googleSubject: "google-user-1", credentialAccount: "old@example.com", consoleAccount: "old@example.com" })
  globalThis.fetch = userinfo({ sub: "google-user-1", email: "old@example.com" })
  await f.balance("old@example.com", 7, false, "google-user-1", {
    googleSubject: "google-user-1", consoleAccount: "new@example.com",
  })
  // Read 1 is the hook's start (the record is complete, so nothing is written
  // and not read again); read 2 is the check after the credits read.
  let reads = 0
  const usage = await f.hooks.auth.usage(async () => {
    if (++reads === 2) f.replace(undefined)
    return f.getAuth()
  })
  assert.match(usage.error, /sign-in changed/)
  assert.equal(usage.balance, undefined)
  assert.equal(f.writes.length, 0)
  assert.equal(await f.getAuth(), undefined)
})

test("a different or missing Google subject cannot replace an established identity", async (t) => {
  const f = await fixture(t)
  f.replace({ ...f.saved, googleSubject: "google-user-1" })
  await f.balance("new@example.com")
  for (const body of [
    { sub: "another-google-user", email: "new@example.com" },
    { sub: "another-google-user" },
    { sub: "another-google-user", email: "not-an-email" },
    {},
  ]) {
    globalThis.fetch = userinfo(body)
    const usage = await f.hooks.auth.usage(f.getAuth)
    assert.match(usage.error, /no longer identify the saved account/)
    assert.equal(usage.balance, undefined)
    assert.equal(usage.windows, undefined)
    assert.equal(f.writes.length, 0)
  }
})

test("sign-out during identity lookup cannot recreate the account", async (t) => {
  const f = await fixture(t)
  globalThis.fetch = async () => {
    f.replace(undefined)
    return { ok: true, json: async () => ({ sub: "google-user-1", email: "new@example.com" }) }
  }
  assert.match((await f.hooks.auth.usage(f.getAuth)).error, /sign-in changed/)
  assert.equal(f.writes.length, 0)
  assert.equal(await f.getAuth(), undefined)
})

test("explicit Console aliases remain scoped to the original credential account", async (t) => {
  const f = await fixture(t)
  globalThis.fetch = userinfo({ sub: "google-user-1", email: "new@example.com" })
  await f.balance("console@example.com", 4)
  const provider = { options: { consoleAccountAliases: { "old@example.com": "console@example.com" } } }
  assert.equal((await f.hooks.auth.usage(f.getAuth, provider)).balance, "$4.00 USD")
  assert.equal((await f.hooks.auth.usage(f.getAuth, provider)).balance, "$4.00 USD")
})

test("a record renamed by an earlier plugin version keeps reading with its credential account", async (t) => {
  // Shape of a record the previous implementation wrote: accountId moved to
  // the new email, credentialAccount kept the original sign-in address.
  const f = await fixture(t)
  f.replace({ ...f.saved, accountId: "new@example.com", credentialAccount: "old@example.com",
    consoleAccount: "new@example.com", consoleSubject: "google-user-1", googleSubject: "google-user-1" })
  globalThis.fetch = userinfo({ sub: "google-user-1", email: "new@example.com" })
  await f.balance("new@example.com")
  const usage = await f.hooks.auth.usage(f.getAuth)
  assert.equal(usage.error, undefined)
  assert.equal(usage.balance, "$7.00 USD")
  assert.equal((await f.getAuth()).accountId, "new@example.com", "an existing key is left as it is, never moved again")
  assert.equal(f.writes.length, 0)
})
