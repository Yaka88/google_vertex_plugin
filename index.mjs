import { readFile } from "node:fs/promises"
import { defaultProfile, validateProject } from "./lib/browser.mjs"
import { resolveIdentity, startLogin, tokenProvider, accountOf } from "./lib/credentials.mjs"
import { fetchCredits, usageOf } from "./lib/credits.mjs"
import { testEndpoint } from "./lib/endpoint.mjs"
import { providerModels, seedModels } from "./lib/models.mjs"

// This plugin is its own provider: Magpie's built-in Vertex row keeps its own
// project, location and ADC path, and nothing here touches it. What the plugin
// adds is the model list Google says the account can call, requests signed
// with the gcloud user's own token, and the promotional-credit balance.
const ID = "gcp-ai"

// Two Google accounts can share one Magpie row: the host keeps each sign-in as
// its own account and calls these hooks once per account, handing that
// account's record in. So what an account recorded beats what the row says —
// otherwise the second account would read the first one's project, Chrome
// profile and ADC. So what an account recorded beats what the row says, and
// both beat the environment: one machine can hold several Google accounts, and
// a machine-wide variable would point all of them at one account's project.
// An environment variable is the last resort, for a machine with no account
// record yet (a first sign-in).
function settings(provider = {}, auth = {}) {
  auth ??= {}
  const options = provider.options ?? {}
  const env = process.env
  return {
    project: auth.project || options.project || env.GOOGLE_VERTEX_PROJECT || env.GOOGLE_CLOUD_PROJECT,
    location: auth.location || options.location || env.GOOGLE_VERTEX_LOCATION || "global",
    billingAccount: auth.billingAccount || options.billingAccount || env.VERTEX_BILLING_ACCOUNT,
    profile: auth.profile || options.profile || env.VERTEX_CHROME_PROFILE || defaultProfile(),
    account: auth.accountId || auth.account || options.account || env.VERTEX_GCLOUD_ACCOUNT,
    authMode: auth.authMode || options.authMode || env.VERTEX_GCLOUD_AUTH_MODE,
    // Only the directory this plugin filed for an account, never a machine-wide
    // CLOUDSDK_CONFIG: one variable would point every account at one ADC, and a
    // sign-in there would overwrite credentials the plugin didn't write.
    cloudsdkConfig: auth.cloudsdkConfig || options.cloudsdkConfig,
  }
}

// The host takes a provider icon as an https URL or a data:image URI from the
// auth hook. The picture is local, so it is read once and inlined; a missing
// file only costs the icon, never the sign-in.
const icon = await readFile(new URL("./assets/icon.png", import.meta.url))
  .then((png) => `data:image/png;base64,${png.toString("base64")}`)
  .catch(() => undefined)

// Where Vertex AI serves Gemini itself: the model is in the path and the body
// is Gemini's own request, which is what the native protocol speaks. Magpie
// appends "/models/<id>:streamGenerateContent?alt=sse" to this base, and
// OpenCode's @ai-sdk/google does the same, so the base ends at the publisher.
function endpoint(project, location) {
  validateProject(project)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(location)) throw new Error("Invalid GOOGLE_VERTEX_LOCATION")
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
  return `https://${host}/v1beta1/projects/${project}/locations/${location}/publishers/google`
}

// The routes Gemini's own API serves under a publisher, and nothing else: a
// model call, its count, and the catalog. The token goes no further than these.
const GEMINI_ROUTE = /^\/models(?:\/[^/]+(?::(?:generateContent|streamGenerateContent|countTokens))?)?$/

function geminiRoute(pathname, base) {
  return GEMINI_ROUTE.test(pathname.slice(base.length))
}

// ADC records a project and a quota project, not who signed in, so a sign-in
// made in ADC mode is saved without an account id and the row reads "Signed
// in". The token can tell the host that account once; it is written back so
// later reads of the sign-in are labelled without asking Google again.
const named = new Set()
// One probe per project and location per process: the answer cannot change
// between two model calls in the same run, and the same run's later loads
// should not ask Google again.
const tested = new Set()

async function endorse(identity, location, owner) {
  // Two accounts can serve the same project and location; the probe is about
  // the credential, so it is remembered per account, not per address.
  const key = `${owner ?? identity.project}/${identity.project}/${location}`
  if (tested.has(key)) return
  const report = await testEndpoint({ ...identity, location }, { models: [], timeout: 15000 })
  if (!report.reachable) throw new Error(`The Google model endpoint is not usable for ${identity.project} (${location}); check that the project exists, the Vertex AI API is enabled and the account may use it`)
  tested.add(key)
}

async function label(client, auth, account) {
  if (!account || auth.accountId === account) return
  const key = `${auth.authMode ?? ""}/${account}`
  if (named.has(key)) return
  named.add(key)
  try { await client?.auth?.set?.({ path: { id: ID }, body: { ...auth, accountId: account } }) } catch { named.delete(key) }
}

export const GoogleVertexAuthPlugin = async (input = {}) => {
  const client = input.client
  let configured = {}
  return {
    // The row's name, protocol and the list it starts with. Magpie lists a
    // plugin provider from what this hook gives it, so a row configured with no
    // models stays empty until someone presses Fetch models; the seed is
    // Google's current catalog so the row is usable before it is signed in.
    // The provider hook below replaces it with what the signed-in project can
    // actually call, which is also where retired models are left out.
    config: async (config) => {
      config.provider ??= {}
      const provider = config.provider[ID] ??= {}
      provider.name ??= "GCP AI"
      // Gemini's own protocol, not the OpenAI-compatible shim: a tool call's
      // thought signature is part of the conversation there, so a second turn
      // with a tool result is accepted as it is, and the reply streams with
      // Vertex's own usage and caching numbers.
      provider.npm ??= "@ai-sdk/google"
      provider.models = { ...seedModels(), ...(provider.models ?? {}) }
      configured = provider
    },
    provider: {
      id: ID,
      // The host asks once per account and hands that account's sign-in in;
      // asking without it would list the first account's models for all of
      // them. This is where the list is read, from Google, with that account's
      // credentials — nobody has to press Fetch models first. A list Google
      // can't be asked for is not replaced with a guess: the row keeps the
      // models it had rather than offer ones the project can't call.
      //
      // The first argument is the whole provider info, not its models — it
      // carries id, name, source and the rest beside `models`. Handing that
      // object back on failure made the host read its keys as model ids and
      // list "id", "name" and "source" as models, so only provider.models is
      // ever given back.
      async models(provider, context) {
        try { return await providerModels(settings(configured, context?.auth), ID) }
        catch { return provider?.models ?? {} }
      },
    },
    auth: {
      provider: ID,
      ...(icon ? { icon } : {}),
      methods: [{
        type: "oauth", label: "Google Cloud ADC / gcloud account (Chrome for credits)",
        // The first account on a machine opens gcloud's consent page directly;
        // a later one opens Google's add-account page first so the account can
        // be picked. Both continue in the same window, and gcloud's exit tells
        // the plugin when to close it; the person never closes it themselves.
        async authorize() {
          const options = settings(configured)
          const login = await startLogin(options)
          return {
            url: "", method: "auto",
            instructions: `A Chrome window opens on Google's consent page and you approve it there; when the plugin already has an account, it opens Google's add-account page first so you can pick which account this is. The plugin closes the window itself when gcloud finishes, so leave it open. An addition counts only when the account approved in the window and the account the new ADC belongs to are the same, and neither was here before; anything else is an overwrite and is removed again. The project is the first of the account's projects that already has the Vertex AI API enabled, chosen automatically; with no such project the sign-in fails instead, so create one and enable the API before trying again. The sign-in expires after ten minutes.`,
            async callback() {
              try {
                const identity = await login.result
                // Consent may already have saved ADC and identified its owner.
                // A project is still required for a usable host record; surface
                // the recovery instructions without saving an incomplete row.
                if (!identity.project) return { type: "failed", error: identity.warning ?? "The sign-in did not finish; nothing was saved" }
                // This run's settings are the row's until it is restarted, so
                // the hooks that were closed over before the sign-in still
                // resolve to the project and profile it used.
                configured = { ...configured, options: { ...(configured.options ?? {}), ...options } }
                const record = { type: "success", access: "", refresh: "", expires: 0, source: "gcloud", authMode: identity.authMode, project: identity.project, billingAccount: options.billingAccount, profile: options.profile, creditsSession: identity.creditsSession }
                // Each account's ADC lives in its own directory: without this
                // the next sign-in would resolve against another account's.
                if (identity.cloudsdkConfig) record.cloudsdkConfig = identity.cloudsdkConfig
                // startLogin names an ADC sign-in from its token; when even
                // that fails the record still succeeds, just unnamed.
                if (identity.account) record.accountId = identity.account
                return { ...record, ...(identity.warning ? { warning: identity.warning } : {}) }
              } catch (error) {
                return { type: "failed", error: error.message }
              } finally { await login.close() } // ends the sign-in's Chrome window
            },
          }
        },
      }],
      // The gcloud user's token signs requests to this project's publisher
      // endpoint only, and only on the Gemini routes it serves.
      async loader(getAuth, provider = configured) {
        const auth = await getAuth()
        const options = settings(provider, auth)
        const identity = await resolveIdentity(options)
        const baseURL = endpoint(identity.project, options.location)
        const getToken = tokenProvider(identity)
        // The host has no test button of its own, so the first request after a
        // sign-in is where an unusable endpoint is named. Reading the location
        // resource is free, runs once per project, and turns a bad project or a
        // disabled API into a clear error instead of a failed model call. No
        // model is asked anything: that is the person's test to make.
        await endorse(identity, options.location, auth?.accountId ?? auth?.project ?? identity.project)
        const allowed = new URL(baseURL)
        return {
          baseURL, apiKey: "vertex-managed",
          async fetch(input, init) {
            const request = new Request(input, init)
            const url = new URL(request.url)
            if (url.origin !== allowed.origin || !url.pathname.startsWith(allowed.pathname + "/")) throw new Error("Refusing to send a Vertex credential outside the configured Google model endpoint")
            if (!geminiRoute(url.pathname, allowed.pathname)) throw new Error("Refusing to send a Vertex credential to a route the Gemini endpoint does not serve")
            const headers = new Headers(request.headers)
            headers.delete("x-goog-api-key")
            headers.delete("x-api-key")
            headers.set("authorization", `Bearer ${await getToken()}`)
            headers.set("x-goog-user-project", identity.project)
            return fetch(new Request(request, { headers, redirect: "error" }))
          },
        }
      },
      async usage(getAuth, provider = configured) {
        try {
          const auth = await getAuth()
          if (!auth) return { error: "GCP AI is not signed in", signIn: "kept" }
          const options = settings(provider, auth)
          // The row is named after this read as well, so a sign-in made before
          // this naming existed is fixed on its next usage refresh.
          if (!auth.accountId && auth.authMode === "adc" && auth.project) {
            void tokenProvider(options)()
              .then((token) => accountOf(token))
              .then((account) => label(client, auth, account)).catch(() => {})
          }
          return usageOf(await fetchCredits(options))
        } catch (error) { return { error: error.message, signIn: "kept" } }
      },
    },
  }
}

export default GoogleVertexAuthPlugin
