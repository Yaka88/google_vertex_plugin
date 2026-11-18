// Gemini's history rules, as Vertex AI holds a generateContent request to
// them, kept here so a conversation an agent left in another shape is sent in
// one Vertex takes (#734). These are the rules magpie's gateway applies to the
// Gemini requests it builds itself (internal/gateway/codeassist.go); a request
// that reaches this plugin some other way, OpenCode's own @ai-sdk/google
// among them, gets them here.
//
// - contents ending with the model's turn: Vertex answers 400 "Requests ending
//   with a model turn are not supported" (Codex compacting on a Gemini model).
//   A user turn goes after it, as Gemini CLI keeps its history ending.
// - contents opening with the model's turn (what an agent's compaction can
//   leave): "function call turn comes immediately after a user turn". Gemini
//   CLI's hardenHistory puts a user turn before it, and so does this.
// - a user turn holding a tool's functionResponse and the user's text: Vertex
//   takes the two as separate turns and answers the same "ending with a model
//   turn" 400, so the text goes in a user turn of its own after the responses.

// What the user turn put after the model's last says: the summary the
// compaction asked for, or to go on.
export const CONTINUE_TEXT = "Continue."
export const COMPACT_LAST_TEXT = "Write the summary of the conversation above that the system prompt asks for."
export const LEADING_USER_TEXT = "[Continuing from previous AI thoughts...]"

// The openings of agents' compaction system prompts, as magpie reads them
// (compactSystems in internal/gateway): within the first 2048 characters.
const COMPACT_SYSTEMS = [
  "You are a helpful AI assistant tasked with summarizing conversations.",
  "You are a context summarization agent.",
  "You are a context summarization assistant.",
  "You are a specialized system component responsible for distilling chat history into a structured XML <state_snapshot>",
  "You are the component that summarizes a conversation when its context window is about to overflow.",
  "You are a context compaction engine. Your summary will REPLACE the original messages in the conversation context window.",
  "You are a helpful assistant that compacts conversation context.",
  "You are compacting a long conversation so it can continue WITHOUT losing context.",
  "You are UPDATING an existing conversation summary with new activity so the conversation can continue WITHOUT losing context.",
]
const COMPACT_LEAD = 2048

function systemText(body) {
  const si = body.systemInstruction ?? body.system_instruction
  const parts = Array.isArray(si?.parts) ? si.parts : []
  return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n")
}

function compacting(body) {
  const system = systemText(body)
  return COMPACT_SYSTEMS.some((p) => {
    const i = system.indexOf(p)
    return i >= 0 && i <= COMPACT_LEAD
  })
}

const roleOf = (turn) => (turn?.role === "model" ? "model" : "user")
const isResponse = (part) => part?.functionResponse != null || part?.function_response != null
// The user's own words: a text part that isn't a thought.
const isSaid = (part) => typeof part?.text === "string" && part.thought !== true

// harden gives body's contents in the shape Vertex takes, and whether it
// changed them; body itself is never changed.
export function harden(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.contents) || body.contents.length === 0) return { body, changed: false }
  let changed = false
  const contents = []
  for (const turn of body.contents) {
    const parts = Array.isArray(turn?.parts) ? turn.parts : null
    if (roleOf(turn) === "user" && parts && parts.some(isResponse) && parts.some(isSaid)) {
      contents.push({ ...turn, parts: parts.filter((p) => !isSaid(p)) })
      contents.push({ role: "user", parts: parts.filter(isSaid) })
      changed = true
      continue
    }
    contents.push(turn)
  }
  if (roleOf(contents[0]) === "model") {
    contents.unshift({ role: "user", parts: [{ text: LEADING_USER_TEXT }] })
    changed = true
  }
  if (roleOf(contents.at(-1)) === "model") {
    contents.push({ role: "user", parts: [{ text: compacting(body) ? COMPACT_LAST_TEXT : CONTINUE_TEXT }] })
    changed = true
  }
  return changed ? { body: { ...body, contents }, changed } : { body, changed }
}

// A model call's body: the route a conversation goes to, and the only one
// these rules are for.
export const CONVERSATION_ROUTE = /:(?:generateContent|streamGenerateContent)$/

// hardenRequest is the request to send. `body` is set only when this had to
// build a new one: that string is already in memory, so a 401 retry can send
// it again. Otherwise `request` is the one that came in, body untouched.
export async function hardenRequest(request) {
  if (request.method !== "POST" || !CONVERSATION_ROUTE.test(new URL(request.url).pathname)) return { request }
  const text = await request.clone().text()
  let parsed
  try { parsed = JSON.parse(text) } catch { return { request } }
  const hardened = harden(parsed)
  if (!hardened.changed) return { request }
  const headers = new Headers(request.headers)
  headers.delete("content-length")
  const body = JSON.stringify(hardened.body)
  return { request: new Request(request, { body, headers }), body }
}
