import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { take, wanted } from "../lib/lock.mjs"

// A browser kept between reads still holds the profile's lock. Another process
// that wants the profile must not have to wait out the whole idle window, so
// the waiter says so on disk and the holder steps aside.

test("a waiter is visible to the holder, and taking the lock clears it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertex-want-"))
  try {
    const file = join(directory, "profile")
    const release = await take(file)
    const takenAt = Date.now()
    assert.equal(await wanted(file), 0)

    // A second taker cannot have the lock, and leaves a mark that it is waiting.
    const waiter = take(file, { timeout: 5000, poll: 20 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.ok((await wanted(file)) > takenAt, "the wait is not visible to the holder")

    await release()
    const second = await waiter
    // The waiter now holds it, so nobody is waiting any more.
    assert.equal(await wanted(file), 0)
    await second()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
