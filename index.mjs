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
// profile and ADC. An environment variable still beats both: it is the
// explicit override for a machine that has one account.
function settings(provider = {}, auth = {}) {
  auth ??= {}
  const options = provider.options ?? {}
  const env = process.env
  return {
    project: env.GOOGLE_VERTEX_PROJECT || env.GOOGLE_CLOUD_PROJECT || auth.project || options.project,
    location: env.GOOGLE_VERTEX_LOCATION || auth.location || options.location || "global",
    billingAccount: env.VERTEX_BILLING_ACCOUNT || auth.billingAccount || options.billingAccount,
    profile: env.VERTEX_CHROME_PROFILE || auth.profile || options.profile || defaultProfile(),
    account: env.VERTEX_GCLOUD_ACCOUNT || auth.accountId || options.account,
    authMode: env.VERTEX_GCLOUD_AUTH_MODE || auth.authMode || options.authMode,
    cloudsdkConfig: auth.cloudsdkConfig || options.cloudsdkConfig || env.CLOUDSDK_CONFIG,
  }
}

// The host takes a provider icon as an https URL or a data:image URI from the
// auth hook. The picture is local, so it is read once and inlined; a missing
// file only costs the icon, never the sign-in.
const icon = await readFile(new URL("./assets/icon.png", import.meta.url))
  .then((png) => `data:image/png;base64,${png.toString("base64")}`)
  .catch(() => undefined)

function endpoint(project, location) {
  validateProject(project)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(location)) throw new Error("Invalid GOOGLE_VERTEX_LOCATION")
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
  return `https://${host}/v1beta1/projects/${project}/locations/${location}/endpoints/openapi`
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
    // The row's name, protocol and startup list. These models are a seed: the
    // provider hook replaces them with what the project can actually call once
    // an account is signed in, so this never overstates a project's access.
    config: async (config) => {
      config.provider ??= {}
      const provider = config.provider[ID] ??= {}
      provider.name ??= "GCP AI"
      provider.npm ??= "@ai-sdk/openai-compatible"
      provider.models = { ...seedModels(), ...(provider.models ?? {}) }
      configured = provider
    },
    provider: {
      id: ID,
      // The host asks once per account and hands that account's sign-in in;
      // asking without it would list the first account's models for all of
      // them. A list Google can't be asked for is not replaced with a guess:
      // the row keeps the models it had rather than offer ones the project
      // can't call.
      models(_models, context) { return providerModels(settings(configured, context?.auth), ID) },
    },
    auth: {
      provider: ID,
      ...(icon ? { icon } : {}),
      methods: [{
        type: "oauth", label: "Google Cloud ADC / gcloud account (Chrome for credits)",
        // Nothing is asked before the window opens. A first sign-in uses the
        // Google account Chrome is already signed in to; a sign-in on a machine
        // that already has an account opens Google's add-another-account page,
        // so a second account is added without typing an address.
        async authorize() {
          const options = settings(configured)
          const login = await startLogin(options)
          return {
            url: "", method: "auto",
            instructions: `Sign in in the Chrome window that opens. The first sign-in uses the Google account Chrome is already signed in to. To add another account, sign in again: Google's "add another account" page opens, and the account you sign in there is the one this row serves. If the account has no Application Default Credentials yet, approving it also makes gcloud write them in a directory of its own, so the models and the Console credits use the same account. Adding an account that is already signed in saves nothing. The window closes automatically after completion or ten minutes.`,
            async callback() {
              try {
                const identity = await login.result
                // A sign-in that could not resolve a project never named an
                // account either: saving it would add an account with nothing
                // behind it, so it fails with the reason instead.
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
      // The gcloud user's token signs requests to this project's endpoint only,
      // and only on the OpenAI-compatible routes it serves.
      async loader(getAuth, provider = configured) {
        const auth = await getAuth()
        const options = settings(provider, auth)
        const identity = await resolveIdentity(options)
        const baseURL = endpoint(identity.project, options.location)
        const getToken = tokenProvider(identity)
        // The host has no test button of its own, so the first request after a
        // sign-in is where an unusable endpoint is named. The probe is free,
        // runs once per project, and turns a bad project or a disabled API into
        // a clear error instead of a failed model call.
        await endorse(identity, options.location, auth?.accountId ?? auth?.project ?? identity.project)
        const allowed = new URL(baseURL)
        const routes = ["/chat/completions", "/completions", "/embeddings", "/models"]
        return {
          baseURL, apiKey: "vertex-managed",
          async fetch(input, init) {
            const request = new Request(input, init)
            const url = new URL(request.url)
            if (url.origin !== allowed.origin || !url.pathname.startsWith(allowed.pathname + "/")) throw new Error("Refusing to send a Vertex credential outside the configured Google model endpoint")
            if (!routes.some((route) => url.pathname === `${allowed.pathname}${route}`)) throw new Error("Refusing to send a Vertex credential to a route the OpenAI-compatible endpoint does not serve")
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
