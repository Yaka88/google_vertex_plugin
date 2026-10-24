import dns from "node:dns"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import { syncBuiltinESMExports } from "node:module"

// Importable by tests and as --import: never retain the real fetch for a test
// to restore. Record violations too, since production fallbacks catch errors.
const unexpected = []
function refuse(kind, target) {
  const message = `Unexpected network ${kind} in test: ${target}`
  unexpected.push(message)
  throw new Error(message)
}
globalThis.fetch = (input) => refuse("fetch", input?.url ?? input)

const local = (host) => {
  const value = String(host ?? "localhost").replace(/^\[|\]$/g, "").toLowerCase()
  return value === "localhost" || value === "::1" || /^127(?:\.\d{1,3}){3}$/.test(value)
}
function check(kind, host) {
  if (!local(host)) refuse(kind, host)
}
function connectionHost(args) {
  const first = args[0]
  if (typeof first === "object") {
    if (first.path) return undefined // Unix pipe, including Chrome's CDP transport.
    return first.host ?? first.hostname
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return undefined // Unix socket.
  return typeof args[1] === "string" ? args[1] : undefined
}
for (const [owner, key] of [[net, "connect"], [net, "createConnection"], [net.Socket.prototype, "connect"], [tls, "connect"]]) {
  const original = owner[key]
  owner[key] = function (...args) {
    // Node may forward already-normalized connect arguments as one array.
    check(key, connectionHost(Array.isArray(args[0]) ? args[0] : args))
    return original.apply(this, args)
  }
}
for (const owner of [http, https]) {
  for (const key of ["request", "get"]) {
    const original = owner[key]
    owner[key] = function (...args) {
      const first = args[0]
      const url = typeof first === "string" || first instanceof URL ? new URL(first) : undefined
      const options = url ? (typeof args[1] === "object" ? args[1] : {}) : first ?? {}
      if (!options.socketPath) check(key, options.hostname ?? options.host ?? url?.hostname)
      return original.apply(this, args)
    }
  }
}
for (const owner of [dns, dns.promises]) {
  const original = owner.lookup
  owner.lookup = function (host, ...args) {
    check("dns.lookup", host)
    return original.call(this, host, ...args)
  }
}
syncBuiltinESMExports()
// Also covers caught errors and fixture subprocesses without importing node:test
// there: its reporter would contaminate gcloud's token output.
process.on("exit", () => {
  if (unexpected.length) {
    console.error(unexpected.join("\n"))
    process.exitCode = 1
  }
})
