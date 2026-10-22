import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { resolveIdentity, tokenProvider } from "./credentials.mjs"

// Vertex has no "models this account may use" list: the publisher catalog is
// global, and it names models that a project cannot call (retired 1.5, preview
// ids, publishers not enabled). So the list is read from Google here, then each
// candidate that could answer chat is asked one free countTokens, and only the
// ones that answer are listed.
const API = "https://aiplatform.googleapis.com/v1beta1"
// Everything Vertex publishes under google/ that is not a chat model: speech,
// transcription, translation, embeddings, live audio and image generation.
const NOT_CHAT = /tts|embedding|transcribe|live|translate|image|nano-banana|omni/

const isChatCandidate = (id) => id.startsWith("gemini-") && !NOT_CHAT.test(id)

async function call(token, project, path, init) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "x-goog-user-project": project, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(20000),
  })
  return response
}

async function publisherModels(token, project) {
  const models = []
  let pageToken = ""
  // The endpoint pages at 200; more than one page means more models, not a
  // failure, so every page is read rather than the first one.
  for (let page = 0; page < 20; page++) {
    const query = `?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`
    const response = await call(token, project, `/publishers/google/models${query}`)
    if (!response.ok) throw new Error(`Vertex model catalog answered ${response.status}`)
    const body = await response.json()
    for (const model of body.publisherModels ?? []) models.push(model.name.split("/").pop())
    if (!body.nextPageToken) return models
    pageToken = body.nextPageToken
  }
  throw new Error("Vertex model catalog kept paging; refusing an incomplete list")
}

// The catalog Magpie lists the official provider from adds what the Vertex API
// doesn't say: context window, prices, modalities. Only model ids come from
// Google; these numbers are decoration on top of them.
async function catalog() {
  try {
    const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
    return JSON.parse(await readFile(join(base, "magpie", "models.json"), "utf8"))?.["google-vertex"]?.models ?? {}
  } catch { return {} }
}

// One request at a time: a burst of probes is what the API answers 429 to,
// and a 429 would read as "this project can't call it".
async function inOrder(items, work) {
  const out = []
  for (const item of items) out.push(await work(item))
  return out
}

// A probe that failed for a reason other than "no such model" says nothing
// about the model: a rate limit, a timeout or an outage must not shrink the
// list. Only a clear 404 (or 501, an embedding model) rules a model out.
async function available(token, project, id) {
  try {
    // countTokens is free and answers 200 for a model this project can call.
    const response = await call(token, project, `/projects/${project}/locations/global/publishers/google/models/${id}:countTokens`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    })
    if (response.ok) return true
    if (response.status === 404 || response.status === 501) return false
    return null
  } catch { return null }
}

async function discover(settings) {
  const identity = await resolveIdentity(settings)
  const token = await tokenProvider(identity)()
  const listed = (await publisherModels(token, identity.project)).filter(isChatCandidate)
  const checks = await inOrder(listed, async (id) => [id, await available(token, identity.project, id)])
  const ids = checks.filter(([, ok]) => ok === true).map(([id]) => id)
  // An inconclusive catalog is not an empty one: keep what was listed last
  // rather than tell the user their project serves nothing.
  if (checks.some(([, ok]) => ok === null) && ids.length < 1) throw new Error("Vertex could not confirm which models this project may call; retry shortly")
  if (!ids.length) throw new Error("Vertex lists no chat model this project can call")
  return { project: identity.project, ids }
}

export async function availableModels(settings = {}) {
  const identity = JSON.stringify([settings.project ?? "", settings.account ?? "", settings.authMode ?? ""])
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16)
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  const file = join(base, "magpie", "gcp-ai", `models-${digest}.json`)
  const ttl = Number(settings.ttl ?? process.env.VERTEX_MODELS_CACHE_TTL ?? 21600)
  if (!Number.isFinite(ttl) || ttl < 0) throw new Error("VERTEX_MODELS_CACHE_TTL must be a nonnegative number of seconds")
  let last
  try {
    last = JSON.parse(await readFile(file, "utf8"))
    const age = Date.now() - Date.parse(last.fetchedAt)
    if (!settings.force && age >= 0 && age < ttl * 1000 && Array.isArray(last.ids) && last.ids.length > 1) return last
  } catch {}
  // A discovery that fails after a good list was cached keeps that list: a
  // reboot, a lapsed sign-in or a flaky probe must not blank the models out.
  const keep = async (error) => {
    if (Array.isArray(last?.ids) && last.ids.length) return { ...last, stale: true }
    throw error
  }
  const found = await discover(settings).catch(keep)
  // A list kept from an earlier read is not written back as if fresh: the
  // next attempt asks Google again rather than wait out a new TTL.
  if (found.stale) return found
  const result = { ...found, fetchedAt: new Date().toISOString() }
  const temp = `${file}.${process.pid}.tmp`
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temp, JSON.stringify(result) + "\n", { mode: 0o600 })
    await rename(temp, file)
  } finally { await rm(temp, { force: true }) }
  return result
}

// The list a row starts from, before an account has been asked anything. It is
// a seed, not a catalog: the provider hook replaces every entry with the models
// Google says this project can call as soon as a sign-in is there. Its only job
// is to name the row and its protocol, so a machine that never signed in still
// shows a usable provider rather than an empty one.
const SEED = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
]

// seedModels is the config hook's models: names and numbers only, in the shape
// models.dev uses for a catalog entry.
export function seedModels() {
  return Object.fromEntries(SEED.map((model) => [model, {
    id: model, name: model.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    limit: { context: 1048576, output: 65536 },
    reasoning: true, tool_call: true, temperature: true, attachment: true,
    modalities: { input: ["text", "image", "audio", "video", "pdf"], output: ["text"] },
    cost: { input: 0, output: 0, cache_read: 0 },
  }]))
}

// providerModels is what the host's provider hook returns for a row: the ids
// Google says the account can call, dressed with the catalog's numbers.
// Nothing cached and Google unreachable makes this throw: the host keeps the
// row's last list rather than read the failure as "no models".
export async function providerModels(settings, id) {
  const { ids } = await availableModels(settings)
  return toProviderModels(ids, await catalog(), id)
}

// Newest first. Google lists the catalog oldest first, and the catalog's
// release date is what orders the ones it knows; a model it doesn't describe
// is placed after them, in the reverse of the order Google listed it.
function newestFirst(ids, catalogModels) {
  return ids
    .map((model, index) => ({ model, index, date: catalogModels[model]?.release_date ?? "" }))
    .sort((a, b) => (a.date === b.date ? b.index - a.index : a.date < b.date ? 1 : -1))
    .map(({ model }) => model)
}

// toProviderModels is the discovered ids as the host's provider hook wants
// them, with the catalog's numbers where it knows the model.
export function toProviderModels(ids, catalogModels, id) {
  return Object.fromEntries(newestFirst(ids, catalogModels).map((model) => {
    const known = catalogModels[model] ?? {}
    const input = known.modalities?.input ?? ["text", "image", "audio", "video", "pdf"]
    const modalities = Object.fromEntries(["text", "image", "audio", "video", "pdf"].map((kind) => [kind, input.includes(kind)]))
    const efforts = known.reasoning_options?.find((option) => option.type === "effort")?.values
    return [model, {
      id: model, providerID: id, name: known.name ?? model,
      api: { id: `google/${model}`, npm: "@ai-sdk/openai-compatible", url: API },
      status: "active", headers: {}, options: {},
      variants: efforts ? Object.fromEntries(efforts.map((effort) => [effort, { reasoning_effort: effort }])) : {},
      cost: { input: known.cost?.input ?? 0, output: known.cost?.output ?? 0, cache: { read: known.cost?.cache_read ?? 0, write: 0 } },
      limit: known.limit ?? { context: 1048576, output: 65536 },
      capabilities: {
        temperature: known.temperature !== false, reasoning: known.reasoning !== false,
        attachment: known.attachment !== false, toolcall: known.tool_call !== false,
        input: modalities, output: { ...modalities, image: false, audio: false, video: false, pdf: false }, interleaved: false,
      },
      release_date: known.release_date ?? "",
    }]
  }))
}
