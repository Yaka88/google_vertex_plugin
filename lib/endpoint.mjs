import { resolveIdentity, tokenProvider } from "./credentials.mjs"

// This is the check the official Vertex provider runs: the project's location
// resource. It answers whether the endpoint, the project, the location and the
// caller's permission are all right, without spending a model request.
const API = "https://aiplatform.googleapis.com/v1"

export function locationUrl(project, location) {
  return `${API}/projects/${project}/locations/${location}`
}

export async function checkLocation(token, project, location, timeout = 15000) {
  const started = Date.now()
  const response = await fetch(locationUrl(project, location), {
    headers: { authorization: `Bearer ${token}`, "x-goog-user-project": project },
    signal: AbortSignal.timeout(timeout),
  })
  const body = await response.json().catch(() => undefined)
  return {
    ok: response.ok, status: response.status, ms: Date.now() - started,
    ...(body?.locationId ? { locationId: body.locationId } : {}),
    ...(body?.error?.message ? { error: String(body.error.message).split("\n")[0] } : {}),
  }
}

// A model probe answers what the location test cannot: which models this
// project may actually call. countTokens is free and is the cheapest call
// Vertex offers.
export async function checkModel(token, project, location, model, timeout = 20000) {
  const started = Date.now()
  const response = await fetch(
    `${API}/projects/${project}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:countTokens`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-goog-user-project": project, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      signal: AbortSignal.timeout(timeout),
    },
  )
  const body = await response.json().catch(() => undefined)
  return {
    model, ok: response.ok, status: response.status, ms: Date.now() - started,
    ...(body?.totalTokens !== undefined ? { tokens: body.totalTokens } : {}),
    ...(body?.error?.message ? { error: String(body.error.message).split("\n")[0] } : {}),
  }
}

// A location that answers, or refuses for a reason about the project or the
// model, proves the endpoint is reachable. Only a rejected credential, a quota
// block or a server failure means it cannot be used at all.
const UNUSABLE = new Set([401, 429, 500, 502, 503, 504])

export async function testEndpoint(settings = {}, { models = [], timeout = 20000 } = {}) {
  const identity = await resolveIdentity(settings)
  const location = settings.location || "global"
  const token = await tokenProvider(identity)()
  const where = { project: identity.project, location, ...(identity.account ? { account: identity.account } : {}) }
  let locationTest
  try { locationTest = await checkLocation(token, identity.project, location) }
  catch (error) { locationTest = { ok: false, ms: 0, error: error.name === "TimeoutError" ? "no answer in time" : error.message } }
  if (!locationTest.ok) {
    return { ...where, authMode: identity.authMode, reachable: !UNUSABLE.has(locationTest.status), locationTest, models: [] }
  }
  const candidates = models.length ? models : ["gemini-2.5-flash"]
  const probes = []
  for (const model of candidates) {
    try { probes.push(await checkModel(token, identity.project, location, model.replace(/^google\//, ""), timeout)) }
    catch (error) { probes.push({ model, ok: false, ms: 0, error: error.name === "TimeoutError" ? "no answer in time" : error.message }) }
  }
  return {
    ...where, authMode: identity.authMode, reachable: true, locationTest, models: probes,
    served: probes.filter((p) => p.ok).map((p) => p.model),
  }
}

export function summarize(report) {
  const line = report.locationTest
    ? `Location ${report.locationTest.ok ? "ok" : `failed (${report.locationTest.status ?? "no answer"})`} · ${report.locationTest.ms}ms${report.locationTest.error ? `\n  ${report.locationTest.error}` : ""}`
    : "Location not tested"
  const lines = [
    `Endpoint ${report.reachable ? "reachable" : "UNREACHABLE"}: ${locationUrl(report.project, report.location)}`,
    `Project ${report.project} · ${report.location}${report.account ? ` · ${report.account}` : ""}`,
    line,
  ]
  for (const probe of report.models) {
    const verdict = probe.ok ? "ok" : probe.status ? `failed (${probe.status})` : "failed"
    lines.push(`  ${probe.model}: ${verdict} · ${probe.ms}ms${probe.tokens !== undefined ? ` · ${probe.tokens} tokens` : ""}${probe.error ? `\n    ${probe.error}` : ""}`)
  }
  if (report.models.length) lines.push(report.served.length ? `${report.served.length} of ${report.models.length} models answered` : "No model answered")
  return lines.join("\n")
}
