import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

// A lock that holds across processes, not just within one. magpie asks each
// account's row separately and may do it in a process of its own, so an
// in-process guard would let two of them reach the same Chrome profile at once.
//
// The lock file holds the holder's pid. A lock left behind by a process that
// has ended (a crash, a kill, a reboot) is removed rather than waited on: the
// pid is checked against the running processes, and a PID the machine handed
// out again after a reboot is not taken for the holder.

// alive asks the operating system whether pid is still running, on every
// platform: signal 0 checks for the process without sending anything. ESRCH
// means it is gone; EPERM means it exists but belongs to someone else, which
// is still alive. Any other error is not proof either way, and the caller
// falls back to the lock's age.
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    if (error?.code === "EPERM") return true
    return undefined
  }
}

async function abandoned(path) {
  const locked = (await stat(path)).mtimeMs
  let pid
  try { pid = Number((await readFile(path, "utf8")).trim()) } catch { return Date.now() - locked > 10000 }
  // An empty lock is one just created by another process, not one abandoned:
  // only a lock that stayed empty is stale.
  if (!pid) return Date.now() - locked > 10000
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  const running = alive(pid)
  if (running === false) return true
  if (running === undefined) return Date.now() - locked > 10 * 60 * 1000
  if (process.platform === "linux") {
    try {
      // A known live holder outranks age; a reused pid started after the lock.
      const started = (await stat(`/proc/${pid}`)).mtimeMs
      return started > locked + 1000
    } catch {}
  }
  // A reused pid cannot hold the lock forever where its start time cannot be
  // checked. Fifteen minutes leaves room for the ten-minute sign-in limit.
  return Date.now() - locked > 15 * 60 * 1000
}

// take waits for the lock and returns the function that gives it back. Waiting
// is the point: the caller has nothing better to do than let the other read
// finish, and failing here would only show the user a lock error.
export async function take(file, { timeout = 180000, poll = 250, busy = "Another process is still using this; retry shortly" } = {}) {
  const path = `${file}.lock`
  const deadline = Date.now() + timeout
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600)
      await handle.writeFile(String(process.pid))
      // Nobody is waiting any more: the flag is about a waiter that has not
      // got the lock yet, not a record of who once wanted it.
      await rm(`${file}.want`, { force: true }).catch(() => {})
      let released = false
      return async () => {
        if (released) return
        released = true
        await handle.close().catch(() => {})
        // The moment of release, for callers that want a gap before the next
        // hold. Written before the lock goes, so a waiter that takes it at
        // once still sees the time.
        await writeFile(`${file}.since`, new Date().toISOString(), { mode: 0o600 }).catch(() => {})
        await rm(path, { force: true })
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (await abandoned(path)) { await rm(path, { force: true }); continue }
      // Say that someone is waiting, so a holder that is only keeping the lock
      // warm lets go now instead of making this process sit out its leisure.
      await writeFile(`${file}.want`, String(process.pid), { mode: 0o600 }).catch(() => {})
      if (Date.now() >= deadline) throw new Error(busy)
      await new Promise((resolve) => setTimeout(resolve, poll))
    }
  }
}

// wanted is when someone last said it was waiting for this lock: a time later
// than the moment the caller took it means a process is waiting right now.
export async function wanted(file) {
  try { return (await stat(`${file}.want`)).mtimeMs } catch { return 0 }
}

// apart waits until at least `gap` milliseconds have passed since the last
// release. Two Google accounts sharing a Chrome profile are read one after
// another with breathing room between them, rather than back to back: the
// profile is a real browser session with Google, not a file to be reopened.
export async function apart(file, gap) {
  if (!(gap > 0)) return
  let last
  try { last = Date.parse(await readFile(`${file}.since`, "utf8")) } catch { return }
  if (!Number.isFinite(last)) return
  const wait = last + gap - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

