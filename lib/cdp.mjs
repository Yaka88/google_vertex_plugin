import { spawn } from "node:child_process"

// A small Chrome DevTools Protocol client over the pipe transport.
//
// Chrome is started with --remote-debugging-pipe, which speaks CDP on file
// descriptors 3 (commands in) and 4 (responses out) of the process this module
// starts. Nothing listens on a TCP port, so no other process on the machine can
// reach the Google session the browser holds, and the plugin never drives a
// Chrome it did not start itself. That is why this is not Playwright: the only
// page operations used are navigation and evaluating a function in the page.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const timeoutError = (message) => Object.assign(new Error(message), { name: "TimeoutError" })

// Delimited messages: Chrome writes one JSON object per NUL.
class Pipe {
  constructor(child) {
    this.child = child
    this.toChrome = child.stdio[3]
    this.fromChrome = child.stdio[4]
    this.buffer = ""
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.events = new Map()
    this.closed = false
    this.closedReason = "Chrome was closed"
    this.fromChrome.setEncoding("utf8")
    this.fromChrome.on("data", (chunk) => this.read(chunk))
    this.fromChrome.on("end", () => this.shut("Chrome closed the debugging connection"))
    this.fromChrome.on("error", () => this.shut("Chrome closed the debugging connection"))
    this.toChrome.on("error", () => this.shut("Chrome closed the debugging connection"))
    child.once("exit", (code) => this.shut(`Chrome exited (${code ?? "signal"})`))
  }

  read(chunk) {
    this.buffer += chunk
    for (let end = this.buffer.indexOf("\0"); end >= 0; end = this.buffer.indexOf("\0")) {
      const raw = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      let message
      try { message = JSON.parse(raw) } catch { continue }
      if (message.id === undefined) {
        // An event: a message Chrome sends on its own. Each is delivered to the
        // listeners of the session it belongs to.
        for (const listener of this.events.get(`${message.sessionId ?? ""}:${message.method}`) ?? []) listener(message.params ?? {})
        for (const listener of this.events.get(`*:${message.method}`) ?? []) listener(message.params ?? {}, message.sessionId)
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? "Chrome refused the command"))
      else pending.resolve(message.result ?? {})
    }
  }

  shut(reason) {
    if (this.closed) return
    this.closed = true
    this.closedReason = reason
    for (const { reject } of this.pending.values()) reject(new Error(reason))
    this.pending.clear()
    for (const listener of this.listeners) listener()
    this.listeners.clear()
  }

  // Called once when the connection ends, however it ends.
  onClosed(listener) {
    if (this.closed) { listener(); return }
    this.listeners.add(listener)
  }

  subscribe(method, listener, sessionId) {
    const key = `${sessionId ?? ""}:${method}`
    if (!this.events.has(key)) this.events.set(key, new Set())
    this.events.get(key).add(listener)
    return () => this.events.get(key)?.delete(listener)
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(this.closedReason))
    const id = this.nextId++
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.toChrome.write(JSON.stringify(message) + "\0")
    })
  }
}

// One tab. The methods mirror the three things the rest of the plugin asks a
// page for: navigate, wait for an expression to become truthy, and evaluate an
// expression for its value.
class Page {
  constructor(connection, sessionId, targetId) {
    this.connection = connection
    this.sessionId = sessionId
    this.targetId = targetId
    this.closed = false
  }

  send(method, params) {
    return this.connection.send(method, params, this.sessionId)
  }

  isClosed() {
    return this.closed || this.connection.closed
  }

  async url() {
    try {
      const { result } = await this.send("Runtime.evaluate", { expression: "location.href", returnByValue: true })
      return String(result?.value ?? "")
    } catch { return "" }
  }

  async evaluate(fn, arg) {
    const expression = typeof fn === "string" ? fn : `(${fn.toString()})(${arg === undefined ? "undefined" : JSON.stringify(arg)})`
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    })
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description?.split("\n")[0] ?? exceptionDetails.text ?? "The page threw while it was read")
    }
    return result?.value
  }

  // Playwright's waitForFunction returns a handle whose value is read with
  // jsonValue(); the same shape is kept so callers do not care which client
  // opened the page.
  async waitForFunction(fn, arg, { timeout = 30000 } = {}) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Page wait timeout must be a positive number of milliseconds")
    const deadline = Date.now() + timeout
    for (;;) {
      if (this.isClosed()) throw new Error("Google Cloud page closed while checking the session")
      try {
        const value = await this.evaluate(fn, arg)
        if (value) return { jsonValue: async () => value, dispose: async () => {} }
      } catch (error) {
        // A navigation destroys the execution context the expression was
        // running in; the next attempt runs in the new document.
        if (this.isClosed()) throw new Error("Google Cloud page closed while checking the session", { cause: error })
        // A page whose document is not up yet has nothing to answer with: that
        // is a reason to ask again, not a failure of the expression.
        if (/Cannot find context|Execution context was destroyed|Inspected target navigated|Target closed|not available|frame was detached|no execution context/i.test(error.message)) {
          if (Date.now() >= deadline) throw timeoutError(`Timed out after ${timeout}ms waiting for the page`)
          await sleep(100)
          continue
        }
        if (!/context was destroyed|Cannot find context|Execution context|Inspected target navigated|Target closed|not available|frame was detached/i.test(error.message)) throw error
      }
      if (Date.now() >= deadline) throw timeoutError(`Timed out after ${timeout}ms waiting for the page`)
      await sleep(100)
    }
  }

  // Navigation reports its own failure; the wait for the document to leave the
  // loading state is bounded separately, because callers poll the page for what
  // they actually want and a slow Console never means the address was wrong.
  async goto(url, { timeout = 60000 } = {}) {
    if (this.closed) throw new Error("Google Cloud page closed before it could be opened")
    const { errorText } = await this.send("Page.navigate", { url })
    if (errorText) throw new Error(`Could not open ${url}: ${errorText === "net::ERR_ABORTED" ? "the navigation was replaced by a redirect" : errorText}`)
    const deadline = Date.now() + Math.min(timeout, 30000)
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate("document.readyState")
        if (state && state !== "loading") return
      } catch (error) {
        if (this.isClosed()) return
        if (!/context|navigated|not available|Target closed/i.test(error.message)) throw error
      }
      await sleep(50)
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    if (this.connection.closed) return
    await this.connection.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {})
  }
}

export class Browser {
  constructor(child, connection) {
    this.child = child
    this.connection = connection
    this.pages = new Set()
  }

  // A new tab, for the consent page gcloud asks to have opened: it is closed on
  // its own and leaves the Console page underneath where it was.
  async newPage() {
    const { targetId } = await this.connection.send("Target.createTarget", { url: "about:blank" })
    return this.attach(targetId)
  }

  async attach(targetId) {
    const { sessionId } = await this.connection.send("Target.attachToTarget", { targetId, flatten: true })
    const page = new Page(this.connection, sessionId, targetId)
    this.pages.add(page)
    page.send("Page.enable").catch(() => {})
    return page
  }

  async firstPage(timeout = 15000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const { targetInfos = [] } = await this.connection.send("Target.getTargets").catch(() => ({}))
      const found = targetInfos.find((target) => target.type === "page")
      if (found) return this.attach(found.targetId)
      if (this.connection.closed) throw new Error(this.connection.closedReason)
      await sleep(100)
    }
    throw new Error("Chrome did not open a page")
  }

  // Ending the process ends the profile's session: the cookies stay on disk,
  // and no Chrome is left running behind the user. The promise settles only
  // when the process is gone, so whoever holds the profile's lock can be sure
  // the next Chrome is not starting on top of this one.
  async close() {
    for (const page of this.pages) page.closed = true
    const exited = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve()
      else this.child.once("exit", resolve)
    })
    await this.connection.send("Browser.close").catch(() => {})
    this.connection.shut("Chrome was closed")
    let timer
    const gone = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000) }),
    ]).finally(() => clearTimeout(timer))
    if (!gone) {
      this.child.kill("SIGTERM")
      const stopped = await Promise.race([
        exited.then(() => true),
        sleep(3000).then(() => false),
      ])
      if (!stopped) {
        this.child.kill("SIGKILL")
        await Promise.race([exited, sleep(2000)])
      }
    }
  }
}

// Chrome answers CDP on descriptors 3 and 4 of the process started here. That
// is a private pipe, not a port: nothing else on the machine can connect to it.
export function launch(executable, args, { timeout = 30000 } = {}) {
  const child = spawn(executable, [...args, "--remote-debugging-pipe"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    detached: false,
  })
  const connection = new Pipe(child)
  const failed = new Promise((_, reject) => {
    child.once("error", (error) => {
      connection.shut("Chrome could not be started")
      reject(error.code === "ENOENT"
        ? new Error("Chrome not found; set VERTEX_CHROME_PATH to its executable")
        : new Error(`Chrome could not be started: ${error.message}`))
    })
    child.once("exit", (code) => {
      connection.shut(`Chrome exited (${code ?? "signal"})`)
    })
  })
  failed.catch(() => {})
  const browser = new Browser(child, connection)
  // A profile that is already open refuses the second launch: Chrome prints
  // that and exits, which the first command below reports as a closed pipe.
  return Promise.race([browser.firstPage(timeout).then((page) => ({ browser, page })), failed])
}
