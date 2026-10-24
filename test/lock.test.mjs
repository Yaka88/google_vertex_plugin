import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apart, take } from "../lib/lock.mjs"

// Two accounts on one Chrome profile are read one after the other, and magpie
// may run each account's read in a process of its own — so the lock that keeps
// them apart has to be a file, and a hold has to be something another process
// waits on rather than fails on.

test("a lock held by another process is waited for, then taken", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-lock-"))
  try {
    const file = join(directory, "balance")
    const release = await take(file)
    // A second taker does not fail: it waits, and gets the lock once released.
    let taken = false
    const waiter = take(file, { poll: 20 }).then((done) => { taken = true; return done })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(taken, false)
    await release()
    const second = await waiter
    assert.equal(taken, true)
    await second()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("releasing twice frees the lock once, and the gap counts from the release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-lock-"))
  try {
    const file = join(directory, "balance")
    const release = await take(file)
    await release()
    // A second release must not remove a lock someone else now holds.
    const held = await take(file)
    await release()
    await assert.rejects(take(file, { timeout: 50, poll: 10 }), /still using|retry shortly/)
    await held()
    // The recorded release time is what the next reader waits out.
    const before = Date.now()
    await apart(file, 300)
    assert.ok(Date.now() - before >= 250)
    await apart(file, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("a live pid cannot keep an abandoned lock past fifteen minutes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-lock-"))
  // With no /proc start time available, a reused pid is indistinguishable
  // from the holder. The age ceiling must still leave a full sign-in time.
  const original = process.platform
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
  try {
    const file = join(directory, "balance")
    await writeFile(`${file}.lock`, String(process.pid))
    const recent = new Date(Date.now() - 11 * 60 * 1000)
    await utimes(`${file}.lock`, recent, recent)
    await assert.rejects(take(file, { timeout: 50, poll: 10 }), /retry shortly/)
    const stale = new Date(Date.now() - 16 * 60 * 1000)
    await utimes(`${file}.lock`, stale, stale)
    const release = await take(file, { timeout: 500, poll: 20 })
    assert.equal(await readFile(`${file}.lock`, "utf8"), String(process.pid))
    await release()
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test("a lock left by a process that has ended is not waited on", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-lock-"))
  try {
    const file = join(directory, "balance")
    // A pid that cannot be running, as a crash or a reboot leaves behind.
    await writeFile(`${file}.lock`, String(2 ** 22 + 7))
    const release = await take(file, { timeout: 500, poll: 20 })
    await release()
    // A lock that is still empty is one just being created, not an abandoned
    // one, and it is waited on rather than swept away.
    await writeFile(`${file}.lock`, "")
    await assert.rejects(take(file, { timeout: 300, poll: 20 }), /retry shortly/)
    assert.equal(await readFile(`${file}.lock`, "utf8"), "")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("Linux keeps a live holder even when its lock is over fifteen minutes old", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-lock-"))
  const original = Date.now
  let release
  try {
    const file = join(directory, "balance")
    release = await take(file)
    // Advance wall time without placing the lock before this process started.
    Date.now = () => original() + 16 * 60 * 1000
    await assert.rejects(take(file, { timeout: 50, poll: 10 }), /retry shortly/)
    assert.equal(await readFile(`${file}.lock`, "utf8"), String(process.pid))
  } finally {
    Date.now = original
    await release?.()
    await rm(directory, { recursive: true, force: true })
  }
})
