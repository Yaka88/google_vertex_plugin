import "./network.mjs"
import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../index.mjs"
import { fakeGcloud } from "./gcloud.mjs"
import { COMPACT_LAST_TEXT, CONTINUE_TEXT, LEADING_USER_TEXT, harden } from "../lib/history.mjs"

// Codex's compaction prompt, as it asks for the summary (#734's case: Codex
// compacting a delegate's conversation on gemini-4-argon).
const CODEX_COMPACT = "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task."

// Vertex AI's 400s, as #734 and magpie's #1533 were shown them: contents
// ending with the model's turn, or a user turn with a tool's response and the
// user's text, which Vertex takes as two turns.
function vertexRefuses(body) {
  const contents = body.contents ?? []
  if (contents.at(-1)?.role === "model") return "Requests ending with a model turn are not supported."
  if (contents[0]?.role === "model") return "Please ensure that function call turn comes immediately after a user turn or after a function response turn."
  for (const turn of contents) {
    const parts = turn.parts ?? []
    if (parts.some((p) => p.functionResponse) && parts.some((p) => typeof p.text === "string")) return "Requests ending with a model turn are not supported."
  }
  return ""
}

// The conversation of #734 in the shape @ai-sdk/google sends it: a tool call
// and its answer, then the model's reply last, which Codex's compaction hands
// on as it is.
const endsWithModel = () => ({
  systemInstruction: { parts: [{ text: "You are Codex, a coding agent." }] },
  contents: [
    { role: "user", parts: [{ text: "fix the bug" }] },
    { role: "model", parts: [{ functionCall: { name: "shell", args: { command: ["ls"] } }, thoughtSignature: "c2ln" }] },
    { role: "user", parts: [{ functionResponse: { name: "shell", response: { name: "shell", content: "main.go" } } }] },
    { role: "model", parts: [{ text: "Fixed it in main.go." }] },
  ],
  generationConfig: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
})

test("contents ending with the model's turn get a user turn after it, the summary asked when compacting (#734)", () => {
  const body = endsWithModel()
  assert.match(vertexRefuses(body), /ending with a model turn/)
  const before = structuredClone(body)
  const { body: out, changed } = harden(body)
  assert.equal(changed, true)
  assert.deepEqual(body, before, "the caller's body is not changed")
  assert.equal(vertexRefuses(out), "")
  assert.deepEqual(out.contents.at(-1), { role: "user", parts: [{ text: CONTINUE_TEXT }] })
  assert.deepEqual(out.contents.slice(0, 4), before.contents)
  assert.deepEqual(out.generationConfig, before.generationConfig)

  const compaction = { ...endsWithModel(), systemInstruction: { parts: [{ text: "You are a helpful AI assistant tasked with summarizing conversations." }] } }
  assert.deepEqual(harden(compaction).body.contents.at(-1), { role: "user", parts: [{ text: COMPACT_LAST_TEXT }] })
})

test("contents opening with the model's turn get a user turn before it", () => {
  const body = { contents: endsWithModel().contents.slice(1, 3) }
  const { body: out, changed } = harden(body)
  assert.equal(changed, true)
  assert.deepEqual(out.contents[0], { role: "user", parts: [{ text: LEADING_USER_TEXT }] })
  assert.equal(vertexRefuses(out), "")
})

test("a tool's response and the compaction prompt in one user turn go as two turns, the responses first (#1533's shape)", () => {
  const body = {
    contents: [
      { role: "user", parts: [{ text: "Read a sample file." }] },
      { role: "model", parts: [{ functionCall: { id: "call_1", name: "read_sample", args: { path: "sample.txt" } } }, { functionCall: { id: "call_2", name: "read_sample", args: { path: "other.txt" } } }] },
      { role: "user", parts: [
        { functionResponse: { id: "call_1", name: "read_sample", response: { output: "Sample file content: hello." } } },
        { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
        { functionResponse: { id: "call_2", name: "read_sample", response: { output: "other" } } },
        { text: CODEX_COMPACT },
      ] },
    ],
  }
  assert.match(vertexRefuses(body), /ending with a model turn/)
  const { body: out } = harden(body)
  assert.equal(vertexRefuses(out), "")
  assert.equal(out.contents.length, 4)
  const [tools, said] = out.contents.slice(2)
  assert.equal(tools.role, "user")
  assert.deepEqual(tools.parts.map((p) => Object.keys(p)[0]), ["functionResponse", "inlineData", "functionResponse"])
  assert.deepEqual(said, { role: "user", parts: [{ text: CODEX_COMPACT }] })
})

test("contents Vertex already takes are left as they are", () => {
  const body = { contents: [...endsWithModel().contents, { role: "user", parts: [{ text: "and the test?" }] }] }
  const { body: out, changed } = harden(body)
  assert.equal(changed, false)
  assert.equal(out, body)
  for (const odd of [undefined, null, {}, { contents: [] }, { contents: "x" }]) assert.equal(harden(odd).changed, false)
})

// End to end through the loader's fetch, as magpie and OpenCode call it: the
// body Vertex is sent is the hardened one, the call's other fields as they came;
// a body that needs nothing goes byte for byte, and a non-conversation route is
// not read at all.
test("the loader's fetch sends Vertex the hardened conversation (#734)", { timeout: 30000 }, async () => {
  const fixture = await fakeGcloud()
  const original = globalThis.fetch
  const sent = []
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input)
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "token", expires_in: 3600 })
    if (url.includes("/v1/projects/")) return Response.json({}, { status: 200 })
    const text = input instanceof Request ? await input.text() : String(init?.body ?? "")
    sent.push({ url, text })
    const refusal = text && !url.includes(":countTokens") ? vertexRefuses(JSON.parse(text)) : ""
    if (refusal) return Response.json({ error: { code: 400, message: refusal, status: "INVALID_ARGUMENT" } }, { status: 400 })
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "summary" }] }, finishReason: "STOP" }] })
  }
  try {
    await fixture.setAdc()
    const hooks = await plugin()
    const auth = { project: "history-project", accountId: "history@example.com", authMode: "adc", cloudsdkConfig: fixture.sdk }
    const loaded = await hooks.auth.loader(async () => auth)
    const call = (route, body) => loaded.fetch(`${loaded.baseURL}/models/gemini-4-argon:${route}`, { method: "POST", body, headers: { "content-type": "application/json" } })

    const asked = JSON.stringify(endsWithModel())
    const response = await call("streamGenerateContent?alt=sse", asked)
    assert.equal(response.status, 200, await response.clone().text())
    const got = JSON.parse(sent.at(-1).text)
    assert.match(sent.at(-1).url, /:streamGenerateContent\?alt=sse$/)
    assert.deepEqual(got.contents.at(-1), { role: "user", parts: [{ text: CONTINUE_TEXT }] })
    assert.deepEqual(got.systemInstruction, endsWithModel().systemInstruction)

    const fine = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] })
    assert.equal((await call("generateContent", fine)).status, 200)
    assert.equal(sent.at(-1).text, fine)
    // countTokens counts what it is given
    assert.equal((await call("countTokens", JSON.stringify({ contents: endsWithModel().contents }))).status, 200)
    assert.equal(JSON.parse(sent.at(-1).text).contents.at(-1).role, "model")
  } finally { globalThis.fetch = original; await fixture.close() }
})
