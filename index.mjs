import { readFile } from "node:fs/promises"
import { defaultProfile, validateProject } from "./lib/browser.mjs"
import { resolveIdentity, startLogin, tokenProvider, identityOf } from "./lib/credentials.mjs"
import { consoleAccountFor, fetchCredits, usageOf } from "./lib/credits.mjs"
import { hardenRequest } from "./lib/history.mjs"
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
    // A Chrome profile directory inside that profile ("Default", "Profile 1"),
    // pinned so Chrome's last-used profile doesn't decide whose session a
    // read uses; profileDirectories picks one per credential account.
    profileDirectory: auth.profileDirectory || options.profileDirectory || env.VERTEX_CHROME_PROFILE_DIRECTORY,
    profileDirectories: options.profileDirectories,
    // Per project, the billing account its credits are read from; per billing
    // account, the currency it bills in (USD unless named).
    billingAccounts: options.billingAccounts,
    billingCurrencies: options.billingCurrencies,
    // The credential selector: gcloud keeps an account's credentials under the
    // address it was signed in with, so it must not follow an email rename.
    account: auth.credentialAccount || auth.accountId || auth.account || options.account || env.VERTEX_GCLOUD_ACCOUNT,
    // The current Console address, which may differ from `account` after a
    // rename; credits are read for it, verified by googleSubject.
    consoleAccount: auth.consoleAccount,
    googleSubject: auth.googleSubject,
    // Explicit aliases: a fallback for a Console session whose email cannot be
    // confirmed by subject (saved address -> current Console address).
    consoleAccountAliases: options.consoleAccountAliases,
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

// A body the caller already holds. A 401 can send it again without copying.
// A stream is not one of these: buffering it on the way out would copy every
// request in case the token was stale, so a 401 on a stream is returned as it is.
function heldBody(body) {
  if (typeof body === "string") return true
  if (body instanceof URLSearchParams) return true
  if (typeof Blob !== "undefined" && body instanceof Blob) return true
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true
  if (typeof FormData !== "undefined" && body instanceof FormData) return true
  return false
}

// The body a 401 can send again: the hardened JSON, or the caller's own
// in-memory body. Undefined means there is nothing cheap to replay.
function replayBody(init, hardened) {
  if (hardened !== undefined) return hardened
  if (init && Object.prototype.hasOwnProperty.call(init, "body") && heldBody(init.body)) return init.body
  return undefined
}

// A probe is remembered for the process, but only a credential refusal blocks
// requests. That verdict expires so a later load can retry recovered credentials.
const tested = new Map()

function endorse(identity, location, owner) {
  // Two accounts can serve the same project and location; the probe is about
  // the credential, so it is remembered per account, not per address. Share
  // the state while it runs so neither a loader nor a model request waits for it.
  const key = JSON.stringify([owner, identity.account, identity.authMode, identity.cloudsdkConfig, identity.project, location])
  if (!tested.has(key)) {
    const state = {}
    tested.set(key, state)
    const probe = () => testEndpoint({ ...identity, location }, { models: [], timeout: 15000 })
    void probe().then(async (report) => {
      if (report.locationTest?.status !== 401) return
      // The probe shares the loader's token cache, so a 401 can mean the cached
      // token was revoked or replaced: drop it and ask once more with a fresh
      // token before holding requests on a verdict a refresh would fix.
      tokenProvider(identity).invalidate()
      report = await probe()
      if (report.locationTest?.status !== 401) return
      state.error = new Error(`The Google model endpoint is not usable for ${identity.project} (${location}); check that the project exists, the Vertex AI API is enabled and the account may use it`)
      const timer = setTimeout(() => { if (tested.get(key) === state) tested.delete(key) }, 60000)
      timer.unref?.()
    }).catch(() => {})
  }
  return key
}

export const GoogleVertexAuthPlugin = async (input = {}, pluginOptions = {}) => {
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
          options.profileDirectory ??= pluginOptions.profileDirectory
          const login = await startLogin(options)
          return {
            url: "", method: "auto",
            instructions: `A Chrome window opens on Google's consent page and you approve it there; when the plugin already has an account, it opens Google's add-account page first so you can pick which account this is. The plugin closes the window itself when gcloud finishes, so leave it open. Google must confirm the new ADC's email and stable subject (sub). A subject already present in a managed ADC is the same Google account even after an email change, so the new credentials are removed and the original ones are kept; if an existing ADC's subject cannot be confirmed, nothing is added. The project is the first of the account's projects that already has the Vertex AI API enabled, chosen automatically; with no such project the sign-in fails instead, so create one and enable the API before trying again. The sign-in expires after ten minutes.`,
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
                const record = { type: "success", access: "", refresh: "", expires: 0, source: "gcloud", authMode: identity.authMode, project: identity.project, billingAccount: options.billingAccount, profile: options.profile, ...(options.profileDirectory ? { profileDirectory: options.profileDirectory } : {}), creditsSession: identity.creditsSession }
                // Each account's ADC lives in its own directory: without this
                // the next sign-in would resolve against another account's.
                if (identity.cloudsdkConfig) record.cloudsdkConfig = identity.cloudsdkConfig
                // startLogin names an ADC sign-in from its token; when even
                // that fails the record still succeeds, just unnamed.
                if (identity.accountId || identity.account) record.accountId = identity.accountId || identity.account
                // Google's stable account ID, saved at sign-in so a later email
                // change can be told apart from a different account.
                if (identity.subject) record.googleSubject = identity.subject
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
        // Probe in the background so a slow location check does not hold up the
        // first model request. Only a credential refusal blocks later requests;
        // loaders for the same credential share the result.
        const probeKey = endorse(identity, options.location, auth?.accountId ?? auth?.project ?? identity.project)
        const allowed = new URL(baseURL)
        return {
          baseURL, apiKey: "vertex-managed",
          async fetch(input, init) {
            const probe = tested.get(probeKey)
            if (probe?.error) throw probe.error
            const asked = new Request(input, init)
            const url = new URL(asked.url)
            if (url.origin !== allowed.origin || !url.pathname.startsWith(allowed.pathname + "/")) throw new Error("Refusing to send a Vertex credential outside the configured Google model endpoint")
            if (!geminiRoute(url.pathname, allowed.pathname)) throw new Error("Refusing to send a Vertex credential to a route the Gemini endpoint does not serve")
            // Gemini's history rules: a conversation ending or opening with
            // the model's turn, or a tool's response beside the user's words,
            // is sent in the shape Vertex takes instead of answered 400 (#734)
            const { request, body: hardened } = await hardenRequest(asked)
            const headers = new Headers(request.headers)
            headers.delete("x-goog-api-key")
            headers.delete("x-api-key")
            headers.set("authorization", `Bearer ${await getToken()}`)
            headers.set("x-goog-user-project", identity.project)
            // Replay a body that is already in memory. Do not clone the request
            // up front: that buffers every body on the chance of a 401. A stream
            // cannot be sent twice, so a 401 on one is returned as it is.
            const retryBody = replayBody(init, hardened)
            const canRetry = retryBody !== undefined || request.body == null
            const send = (body) => body === undefined
              ? fetch(new Request(request, { headers, redirect: "error" }))
              : fetch(new Request(request.url, { method: request.method, headers, body, redirect: "error", signal: request.signal }))
            const response = await send()
            if (response.status !== 401) return response
            if (!canRetry) {
              getToken.invalidate()
              return response
            }
            // Free the connection before the retry: this reply is not returned.
            await response.body?.cancel().catch(() => {})
            headers.set("authorization", `Bearer ${await getToken.refresh()}`)
            return send(retryBody)
          },
        }
      },
      async usage(getAuth, provider = configured) {
        try {
          const auth = await getAuth()
          if (!auth) return { error: "GCP AI is not signed in", signIn: "kept" }
          const options = settings(provider, auth)
          options.consoleAccountAliases ??= pluginOptions.consoleAccountAliases
          options.profileDirectory ??= pluginOptions.profileDirectory
          options.profileDirectories ??= pluginOptions.profileDirectories
          options.billingAccounts ??= pluginOptions.billingAccounts
          options.billingCurrencies ??= pluginOptions.billingCurrencies
          // Validated even when Google can confirm the email by subject.
          const mapped = consoleAccountFor(options.account, options.consoleAccountAliases)
          const aliased = mapped?.toLowerCase() !== options.account?.toLowerCase()
          const snapshot = JSON.stringify(auth)
          // userinfo: the token's current email and its stable `sub`. A failed
          // lookup only leaves the identity unconfirmed for this read.
          const current = options.account || auth.authMode === "adc"
            ? await tokenProvider(options)().then(identityOf).catch(() => undefined) : undefined
          // A different (or missing) subject is another Google account, never
          // this one under a new email.
          if (auth.googleSubject && current && current.subject !== auth.googleSubject) {
            throw new Error("Google credentials no longer identify the saved account; remove it and sign in again")
          }
          const saved = auth
          if (current?.subject) {
            // Console may know a newer email than userinfo: keep an address
            // already confirmed for this same subject. The usage hook does not
            // persist this derived label: client.auth.set is not a conditional
            // write, so persisting here could resurrect a sign-out that races
            // the refresh. Login already stores the stable subject and key.
            options.consoleAccount = auth.consoleSubject === current.subject
              ? auth.consoleAccount || current.account : current.account
            options.googleSubject = current.subject
            // A sign-out or replacement while userinfo was pending wins.
            if (JSON.stringify(await getAuth()) !== snapshot) {
              return { error: "The GCP AI sign-in changed during the refresh; retry", signIn: "kept" }
            }
          }
          if (aliased) options.consoleAccount = mapped
          const credits = await fetchCredits(options)
          // A browser read can outlive a sign-out or replacement: its result
          // is dropped before any label is updated or balance returned.
          if (JSON.stringify(await getAuth()) !== JSON.stringify(saved)) {
            return { error: "The GCP AI sign-in changed during the refresh; retry", signIn: "kept" }
          }
          let user = saved.consoleAccount || current?.account || saved.accountId
          // The Console page named its own subject: when it is this account's,
          // the address it shows is this account's current email. Keep it in
          // this usage result only; the host has no conditional auth.set API.
          if (credits.consoleAccount && options.googleSubject && credits.googleSubject === options.googleSubject) {
            user = credits.consoleAccount
          }
          // usage().user is how Magpie shows the account where it differs from
          // the account's key; the key itself stays accountId.
          return { ...usageOf(credits), ...(user ? { user } : {}) }
        } catch (error) { return { error: error.message, signIn: "kept" } }
      },
    },
  }
}

export default GoogleVertexAuthPlugin
