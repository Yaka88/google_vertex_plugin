import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cacheRoot } from "./browser.mjs"
import { resolveIdentity, tokenProvider } from "./credentials.mjs"

// The list is Google's publisher catalog for the project, read once. It is
// global, so it also names things this project cannot call (retired ids,
// preview models, publishers not enabled); nothing here asks each model whether
// it answers, because that is a round trip per model in front of the row's read
// and a question the person answers better with Test models.
const API = "https://aiplatform.googleapis.com/v1beta1"

// A location is a region name, or the global endpoint.
const LOCATION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// Everything Vertex publishes under google/ that is not a chat model: speech,
// transcription, translation, embeddings, live audio and image generation.
const NOT_CHAT = /tts|embedding|transcribe|live|translate|image|nano-banana|omni/

// Google keeps retired models in the publisher catalog: the listing still names
// them, and calling one answers 404 NOT_FOUND, so taken at face value the list
// offers models that cannot load. Nothing in the listing tells the two apart —
// a retired model's launch stage and template read exactly like a live one's —
// so the list is not taken at face value: each model is asked a question that
// costs nothing (countTokens, not a generation), and the ones that say they are
// not there are left out. Whether a model *answers well* is still the person's
// to find out with Test models; this only drops the ones Google says are gone.
export const isChatCandidate = (id) => id.startsWith("gemini-") && !NOT_CHAT.test(id)

async function call(token, project, path, init) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "x-goog-user-project": project, ...(init?.headers ?? {}) },
    // A caller that brought its own deadline keeps it.
    signal: init?.signal ?? AbortSignal.timeout(20000),
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
    return JSON.parse(await readFile(join(cacheRoot(), "magpie", "models.json"), "utf8"))?.["google-vertex"]?.models ?? {}
  } catch { return {} }
}

function locationOf(settings) {
  const location = settings.location || process.env.GOOGLE_VERTEX_LOCATION || "global"
  if (!LOCATION.test(location)) throw new Error("Invalid GOOGLE_VERTEX_LOCATION")
  return location
}

// gone asks one model whether it is really there. countTokens is the cheapest
// question a model answers: it reads the request and returns a number, without
// generating anything or billing a token. Only NOT_FOUND drops a model — that
// is Google saying the model is not deployed for this project, which is what a
// retired id answers. Any other outcome (a 403 for a model this account may not
// call, a rate limit, a network that dropped, a timeout) leaves the model on
// the list: a question that could not be answered is not an answer, and
// dropping models on a bad minute is how the row loses models that work.
async function gone(token, project, location, id) {
  try {
    const response = await call(token, project, `/projects/${project}/locations/${location}/publishers/google/models/${id}:countTokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "x" }] }] }),
      // Short: this runs per model behind a cache the row is already reading.
      signal: AbortSignal.timeout(8000),
    })
    return response.status === 404
  } catch { return false }
}

// inParallel runs work over items, a few at a time. The probes are independent
// network round trips; doing them one after another is how a 15-model list
// costs 15 timeouts before the row can show anything.
async function inParallel(items, width, work) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await work(items[i], i)
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
  return out
}

// The list is Google's own catalog for the project, read once and then asked
// which of its models are really there. What comes back is what the project can
// call, so nobody has to press Fetch models and then discover by testing that
// half the row is retired.
async function discover(settings) {
  const location = locationOf(settings)
  const identity = await resolveIdentity(settings)
  const token = await tokenProvider(identity)()
  const named = (await publisherModels(token, identity.project)).filter(isChatCandidate)
  if (!named.length) throw new Error(`Vertex lists no chat model in ${location} for ${identity.project}`)
  const absent = await inParallel(named, 6, (id) => gone(token, identity.project, location, id))
  const ids = named.filter((_, i) => !absent[i])
  // Every model saying 404 is not a model list, it is a broken read: a wrong
  // project or location answers NOT_FOUND for everything. Keep Google's names
  // rather than report an empty provider.
  if (!ids.length) return { project: identity.project, location, ids: named }
  return { project: identity.project, location, ids }
}

// One refresh at a time per list: the host may ask twice before the first
// answer is in (a second account, an editor and a request), and two identical
// catalog reads are two chances to be rate limited.
const refreshing = new Map()

async function writeList(file, result) {
  const temp = `${file}.${process.pid}.tmp`
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temp, JSON.stringify(result) + "\n", { mode: 0o600 })
    await rename(temp, file)
  } finally { await rm(temp, { force: true }) }
}

export async function availableModels(settings = {}) {
  // The location is part of the identity: the same project serves a different
  // list in each one, so a list read for global is not one for a region.
  const location = locationOf(settings)
  const identity = JSON.stringify([settings.project ?? "", settings.account ?? "", settings.authMode ?? "", location])
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16)
  const file = join(cacheRoot(), "magpie", "gcp-ai", `models-${digest}.json`)
  const ttl = Number(settings.ttl ?? process.env.VERTEX_MODELS_CACHE_TTL ?? 21600)
  if (!Number.isFinite(ttl) || ttl < 0) throw new Error("VERTEX_MODELS_CACHE_TTL must be a nonnegative number of seconds")
  let last
  try {
    const cached = JSON.parse(await readFile(file, "utf8"))
    // A list read before a retired model was known to be gone still names it:
    // the cached ids are filtered on the way out, so an old cache cannot put a
    // model back on the row after it stopped answering.
    const ids = (Array.isArray(cached?.ids) ? cached.ids : []).filter(isChatCandidate)
    if (ids.length) last = { ...cached, ids }
  } catch { last = undefined }
  const refresh = () => {
    let running = refreshing.get(file)
    if (!running) {
      running = discover(settings)
        .then((found) => writeList(file, { ...found, fetchedAt: new Date().toISOString() }))
        .finally(() => refreshing.delete(file))
      running.catch(() => {})
      refreshing.set(file, running)
    }
    return running
  }
  if (last && !settings.force) {
    const age = Date.now() - Date.parse(last.fetchedAt)
    // A list already known is answered at once, however old it is: this hook
    // runs inside Magpie's own provider read, which waits on every plugin at
    // once, so spending seconds here is how the row ends up with no models at
    // all. An old list is refreshed behind the answer instead of in front of
    // it, and the next read sees what that found.
    if (!(age >= 0 && age < ttl * 1000)) refresh().catch(() => {})
    return last
  }
  // Nothing cached: this read has to ask, and a failure here is the one case
  // the host reports as a list it could not get.
  try {
    const found = await refresh()
    return JSON.parse(await readFile(file, "utf8").catch(() => JSON.stringify(found)))
  } catch (error) {
    // A good list from an earlier read stands in for one that could not be
    // read now: a lapsed token or a flaky probe must not blank the models out.
    if (last) return last
    throw error
  }
}

// The row's models before anything has been read from Google. Magpie lists a
// plugin provider from what the config hook gives it, so a config hook with no
// models is a row that stays empty until someone presses Fetch models — the
// other plugins here (Kiro, WorkBuddy) hand over their own list for exactly
// that reason, and the provider hook replaces it with the account's list once
// it is signed in. These are the models Google's catalog names today; the
// provider hook is what says what the signed-in project can actually call.
//
// The table carries only what the config hook can use (name, context, the
// reasoning levels). Prices, modalities and the rest are decoration the
// provider hook adds from the catalog, so they are not repeated here.
const SEED = [
  ["gemini-4-argon", "Gemini 4 Argon", 1048576, 65536, ["low", "medium", "high"]],
  ["gemini-3.8-flash", "Gemini 3.8 Flash", 1048576, 65536, ["low", "medium", "high"]],
  ["gemini-3.7-flash", "Gemini 3.7 Flash", 1048576, 65536, ["low", "medium", "high"]],
  ["gemini-3.6-flash", "Gemini 3.6 Flash", 1048576, 65536, ["minimal", "low", "medium", "high"]],
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1048576, 65536, ["minimal", "low", "medium", "high"]],
  ["gemini-3.5-flash", "Gemini 3.5 Flash", 1048576, 65536, ["minimal", "low", "medium", "high"]],
  ["gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", 1048576, 65536, ["minimal", "low", "medium", "high"]],
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", 1048576, 65536, ["low", "medium", "high"]],
  ["gemini-3-flash-preview", "Gemini 3 Flash Preview", 1048576, 65536, ["minimal", "low", "medium", "high"]],
  ["gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", 1048576, 65536, []],
  ["gemini-2.5-flash", "Gemini 2.5 Flash", 1048576, 65536, []],
  ["gemini-2.5-pro", "Gemini 2.5 Pro", 1048576, 65536, []],
]

// seedModels is the config hook's models: the shape a row is configured with,
// not the shape the provider hook returns.
export function seedModels() {
  return Object.fromEntries(SEED.map(([id, name, context, output, efforts]) => [id, {
    id, name,
    // The same address the provider hook gives: Gemini's own protocol names the
    // model in the path without a publisher prefix, so a row that has not been
    // signed in yet sends the id as it stands rather than a prefixed guess.
    api: { id, npm: "@ai-sdk/google" },
    limit: { context, output },
    attachment: true,
    modalities: { input: ["text", "image", "video", "audio", "pdf"], output: ["text"] },
    tool_call: true,
    reasoning: efforts.length > 0,
    ...(efforts.length ? { variants: Object.fromEntries(efforts.map((effort) => [effort, { reasoning_effort: effort }])) } : {}),
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
      // Gemini's own API names the model in the path, without a publisher
      // prefix, and its body is the native request: the protocol the official
      // Vertex row speaks, where a tool call's thought signature travels with
      // the conversation instead of being dropped by an OpenAI-shaped shim. No
      // URL here: the account's loader gives the one base for its project and
      // location, which a per-model address would override with global's.
      api: { id: model, npm: "@ai-sdk/google" },
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
