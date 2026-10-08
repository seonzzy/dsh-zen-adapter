/**
 * OpenCode Zen free lane as a native DSH LLM provider.
 *
 * The anonymous Zen lane gates on four things, all of which this adapter
 * reproduces (see the A/B probes recorded in `.scratch/zen-adapter-recon`):
 *
 *   1. `Authorization: Bearer public` — the literal string, not a secret.
 *   2. A CLI-identical header set, including a `ses_`-shaped session id.
 *   3. `stream: true` (pi-ai always streams, so this comes for free).
 *   4. A body carrying function tools named BOTH "bash" and "read".
 *
 * Point 4 is the one that matters most here: several free models (measured:
 * fledge-alpha-free, longcat-2.5-preview-free) answer 403 FreeTierError to a
 * bare request and 200 once both gate tools are present, while
 * space-bunny-free ignores the gate entirely. A plain `llm-pi-ai` settings
 * route cannot satisfy it, because that path exposes no `onPayload` hook.
 *
 * @module dsh-zen-adapter
 */

import { createHash, randomBytes } from 'node:crypto'
import { ZenCatalogService } from './zen-service.js'
import { makeBridgeRoutes } from './bridge.js'

// Resolved through the HOST's module tree. These must stay out of this
// package's `dependencies` — see README, "为什么不会和 dsh-workbuddy-xdpool 冲突".
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createProvider } from '@earendil-works/pi-ai'
// The lazy entry point exports a FACTORY; `createProvider` wants its result.
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

/**
 * Provider id shown in the DSH model picker.
 *
 * Deliberately NOT `zen`: the profile's existing `llm-pi-ai` settings route
 * already claims that id, and `llm.registerAdapter()` is all-or-nothing —
 * a second claimant throws `DUPLICATE_ADAPTER` and nothing registers.
 */
const PROVIDER_ID = 'zen-free'

/** Display name shown in the DSH model picker. */
const PROVIDER_DISPLAY_NAME = 'OpenCode Zen (free lane)'

/** The anonymous lane's key: a literal, not a credential. */
const ANONYMOUS_KEY = 'public'

const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

// ---------------------------------------------------------------------------
// Disguise: ids and headers
// ---------------------------------------------------------------------------

/** sha256("prefix\0value") truncated to 12 bytes: stable, non-reversible. */
function stableID(prefix, value) {
  return `${prefix}_${createHash('sha256').update(`${prefix}\0${value}`).digest().subarray(0, 12).toString('hex')}`
}

function randomID(prefix, size) {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62Fixed(value, width) {
  const base = 62n
  let n = value
  const out = new Array(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base))
    n /= base
  }
  return out.join('')
}

/**
 * The session id sent upstream, in OpenCode's canonical shape:
 * `ses_` + 12 lowercase hex + 14 Base62. The lane rejects any other shape.
 */
function canonicalSessionID(signal) {
  const sum = createHash('sha256').update(`ses\0${signal}`).digest()
  return `ses_${sum.subarray(0, 6).toString('hex')}${base62Fixed(BigInt(`0x${sum.subarray(6, 16).toString('hex')}`), 14)}`
}

function opencodeUserAgent() {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/**
 * The full disguise header set sent with every upstream request.
 *
 * `User-Agent` is spelled in that exact casing on purpose. pi-ai seeds its
 * default headers with the literal key `"User-Agent"` (see
 * `pi-ai/dist/api/openai-completions.js`, `createClient`), and it merges our
 * headers over that record with `Object.assign` — a lowercase `user-agent`
 * would therefore sit BESIDE pi-ai's value rather than replace it, and which
 * one reaches the wire would depend on the HTTP client's case handling.
 * Matching the spelling makes the override unambiguous.
 */
function disguiseHeaders(ids) {
  return {
    'User-Agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}

/**
 * Derive the correlation ids for one upstream request. The conversation's
 * first user turn is the seed, which keeps a multi-turn chat stable while
 * separating conversations that begin differently.
 */
function deriveRequestIDs(messages) {
  let signal = ''
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) {
      signal = encoded
      break
    }
  }
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: canonicalSessionID(signal),
    request: randomID('req', 16),
    project: stableID('prj', 'dsh-zen-adapter:default-project'),
  }
}

// ---------------------------------------------------------------------------
// Disguise: the body-shape gate
// ---------------------------------------------------------------------------

/** The gate: the body's `tools` must contain BOTH of these names. */
const GATE_TOOL_NAMES = ['bash', 'read']

/**
 * A gate tool. Descriptions and parameter schemas go uninspected upstream,
 * so the only thing that matters is the `name`.
 */
function gateTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  }
}

/**
 * Rewrite an outgoing chat-completions payload so it satisfies the gate.
 *
 * Only the missing gate tools are appended, and a body that carried no tools
 * at all gets `tool_choice: "none"` so the model never tries to call the
 * stubs. A caller-supplied `tool_choice` is preserved untouched.
 *
 * @returns the rewritten body, or undefined when nothing had to change.
 */
function ensureFreeLaneShape(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  if (!Array.isArray(payload.messages)) return undefined
  const tools = Array.isArray(payload.tools) ? payload.tools : []
  const names = new Set(
    tools.map((tool) => {
      const fn = typeof tool === 'object' && tool !== null ? tool.function : undefined
      return typeof fn === 'object' && fn !== null ? fn.name : undefined
    }),
  )
  const missing = GATE_TOOL_NAMES.filter((name) => !names.has(name))
  if (missing.length === 0) return undefined
  const next = { ...payload, tools: [...tools, ...missing.map((name) => gateTool(name))] }
  if (tools.length === 0) next.tool_choice = 'none'
  return next
}

/**
 * Wrap a pi-ai provider so every `streamSimple` call is disguised.
 *
 * pi-ai's `onPayload` is the only hook that sees the finished request body,
 * which is why the gate cannot be satisfied from a settings route.
 */
function disguiseProvider(provider) {
  return {
    ...provider,
    stream(model, context, options) {
      return provider.stream(model, context, createDisguisedOptions(context, options))
    },
    streamSimple(model, context, options) {
      return provider.streamSimple(model, context, createDisguisedOptions(context, options))
    },
  }
}

/**
 * Strip any case-variant of a header name we are about to set.
 *
 * `llm-pi-ai` puts a lowercase `user-agent` into `options.headers`, and pi-ai
 * merges that record into its own defaults with `Object.assign`. Left alone,
 * the two spellings coexist, and the OpenAI SDK's `Headers` then COMBINES them
 * into a single value:
 *
 *     user-agent: opencode/1.18.31 (...), dsh/0.2.0
 *
 * The lane inspects this string, so a combined value is not a working
 * disguise. Removing the variant before we write ours is what makes the
 * override a replacement rather than an append.
 *
 * @param headers - the incoming header record.
 * @param ourNames - the names we are about to set.
 * @returns a copy with every colliding spelling removed.
 */
function withoutCollisions(headers, ourNames) {
  const reserved = new Set(ourNames.map((name) => name.toLowerCase()))
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase())))
}

/**
 * Add the disguise to one call's options.
 *
 * The incoming `options.headers` already carries whatever `llm-pi-ai` put
 * there (`requestHeaders(profile.headers)` plus the attribution headers), so
 * ours are merged ON TOP — after dropping any case-variant of a name we own.
 */
function createDisguisedOptions(context, options) {
  const ids = deriveRequestIDs(context?.messages ?? [])
  const callerOnPayload = options?.onPayload
  const disguise = disguiseHeaders(ids)
  return {
    ...options,
    apiKey: ANONYMOUS_KEY,
    headers: { ...withoutCollisions(options?.headers, Object.keys(disguise)), ...disguise },
    onPayload: (payload) => {
      const shaped = ensureFreeLaneShape(payload)
      // The caller's hook runs on the gated body, and its result is RE-GATED
      // rather than trusted: a caller that returns an object would otherwise
      // silently drop the `bash`/`read` requirement, and every request would
      // come back 403.
      const afterCaller = callerOnPayload === undefined ? undefined : callerOnPayload(shaped ?? payload)
      if (afterCaller !== undefined) return ensureFreeLaneShape(afterCaller) ?? afterCaller
      return shaped
    },
  }
}

/**
 * Inert pi-ai auth plane.
 *
 * The anonymous lane authenticates with the literal key `public`, so pi-ai's
 * own credential lifecycle must never manufacture or look one up. This is the
 * same shape dsh-workbuddy-xdpool uses for its loopback route.
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-zen-adapter: this route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  },
}

// ---------------------------------------------------------------------------
// Cordis plugin entry
// ---------------------------------------------------------------------------

export const name = 'dsh-zen-adapter'
export const inject = ['llm']

/**
 * Seed models used only until the live catalogue arrives.
 *
 * The real list is discovered from `/v1/models` ∩ models.dev (see
 * `catalog.js`); these three exist purely so the picker is never empty during
 * the first seconds of a session, and all three are verified to answer on the
 * anonymous lane.
 */
const SEED_MODELS = ['space-bunny-free', 'fledge-alpha-free', 'longcat-2.5-preview-free']

/**
 * Register one adapter that owns the `zen-free` provider.
 *
 * Everything here is loaded from the HOST: `@deepseek-ai/dsh-llm-pi-ai` and
 * `@earendil-works/pi-ai` are resolved through the host's module tree, so no
 * second pi-ai generation lands in the profile and other plugins that check
 * for that (dsh-workbuddy-xdpool) stay aligned.
 *
 * The imports are static on purpose: cordis does not await an async `apply`,
 * so a dynamic `import()` would register the adapter after the entry had
 * already settled.
 */
export function apply(ctx) {
  const logger = ctx.logger

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('dsh-zen-adapter: llm service unavailable; adapter cannot register')
    return
  }

  // Live catalogue. Shared with the detail page's bridge below, so the button
  // and the model picker always describe the same list.
  const catalog = new ZenCatalogService({ logger })

  /** Current model ids: the live free list, or the seed before it loads. */
  const currentModelIds = () => {
    const free = catalog.list().filter((m) => m.reachable !== false)
    return free.length > 0 ? free.map((m) => m.id) : SEED_MODELS
  }

  /**
   * Model descriptors for the current catalogue.
   *
   * `contextWindow`/`maxTokens` come from models.dev rather than a constant:
   * the free roster ranges from 200K to 1M tokens, and claiming 200K for a 1M
   * model throws away most of its capacity, while claiming 1M for a 200K model
   * invites context-overflow failures.
   *
   * Descriptors are rebuilt on every `getModels()` call, which is what makes a
   * catalogue refresh visible without a restart: `PiAiAdapter.current()` keys
   * its memo on the identity of the `profiles` map, and the provider's
   * `getModels` is invoked per snapshot.
   */
  const buildModels = () => {
    const byId = new Map(catalog.list().map((m) => [m.id, m]))
    const ids = currentModelIds()
    return ids.map((id) => {
      const meta = byId.get(id)
      return {
        id,
        name: id,
        api: 'openai-completions',
        provider: PROVIDER_ID,
        baseUrl: ZEN_BASE_URL,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: meta?.context ?? 200000,
        maxTokens: Math.min(meta?.maxOutput ?? 32768, 65536),
        reasoning: meta?.reasoning === true,
      }
    })
  }

  const provider = disguiseProvider({
    // `createProvider`'s `getModels` is a closure over the array handed to it,
    // which would freeze the catalogue at construction time. Overriding it to
    // call `buildModels()` per read is what lets a refresh reach the picker
    // WITHOUT a restart.
    ...createProvider({
      id: PROVIDER_ID,
      name: PROVIDER_DISPLAY_NAME,
      baseUrl: ZEN_BASE_URL,
      auth: { apiKey: { name: 'OpenCode Zen anonymous lane', resolve: async () => ({ auth: { apiKey: ANONYMOUS_KEY } }) } },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  })

  const profile = {
    provider: PROVIDER_ID,
    displayName: PROVIDER_DISPLAY_NAME,
    // NOT optional. The settings route (`resolveProfiles`) fills defaults such
    // as `streamIdleTimeoutMs ?? 3e5`, but an adapter that builds its profile
    // by hand skips that pass, and `streamWithSnapshot` feeds
    // `profile.streamIdleTimeoutMs` straight into `idleWatchdog()` — which
    // rejects `undefined` with "timeoutMs must be a positive finite number".
    //
    // 5 minutes, matching llm-pi-ai's own DEFAULT_STREAM_IDLE_TIMEOUT_MS.
    streamIdleTimeoutMs: 300000,
    // Same reason: read unguarded whenever a request carries an image.
    // Values mirror llm-pi-ai's resolveProfiles defaults.
    maxRequestImageBytes: 20971520,
    requestImagePixelBudget: 4194304,
    requestImageMaxBytes: 1048576,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    piProvider: provider,
  }

  // Fail loudly at registration rather than on the first user turn: the
  // watchdog only complains once a request is already in flight.
  for (const field of ['streamIdleTimeoutMs', 'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes']) {
    const value = profile[field]
    if (!Number.isFinite(value) || value <= 0) {
      logger.error(`dsh-zen-adapter: profile.${field} must be a positive finite number; the adapter will not register`)
      return
    }
  }

  // `PiAiAdapter.current()` memoizes its snapshot on the IDENTITY of whatever
  // `profiles()` returns, so handing back one long-lived Map would freeze the
  // model list for the process lifetime no matter what the catalogue says.
  // A fresh Map per read makes every catalogue refresh visible on the next
  // `listModels`/`resolveModel` — which is the whole point of the refresh
  // button, and costs one small object per call.
  const profiles = () => new Map([[PROVIDER_ID, profile]])

  const adapter = new PiAiAdapter({
    profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => ANONYMOUS_KEY,
  })

  const release = ctx.llm.registerAdapter([PROVIDER_ID], adapter)

  logger.info(`dsh-zen-adapter: registered "${PROVIDER_ID}" with ${currentModelIds().length} model(s)`)

  /**
   * Tell the Host that the model topology changed.
   *
   * This is what actually makes a refresh visible in the picker. The browser
   * half caches one catalog per Host generation and reloads it only on
   * `llm/adapters-updated` / `settings/document-updated` /
   * `credentials/*-updated` (see `dsh-client-ui-model-selection`, its
   * `ModelDirectories` constructor). Registering the adapter fires the event
   * once, which is why the first snapshot reaches the menu at all — but a
   * LATER catalogue change fires nothing, and the menu keeps serving the list
   * it captured at that moment.
   *
   * Emitting it after each successful refresh is what closes that loop: the
   * client invalidates its cached catalog and re-reads `listModels`, which our
   * provider re-computes live.
   */
  const announceModelsChanged = () => {
    const llm = ctx.llm
    if (llm === null || typeof llm !== 'object') return
    // Not fatal: the models are still served, the menu just stays stale until
    // the next host event. A host without this method still picks up the
    // catalogue at startup, because `registerAdapter` fires the event itself.
    if (typeof llm.emitAdaptersUpdated !== 'function') return
    try {
      llm.emitAdaptersUpdated()
    } catch (error) {
      logger.warn?.(`dsh-zen-adapter: could not announce the refreshed catalogue: ${error?.message ?? error}`)
    }
  }

  // Warm the catalogue immediately, then keep it fresh in the background. The
  // adapter is already registered, so a slow or failed fetch costs the user
  // nothing but the seed list for a few seconds.
  const warm = async () => {
    try {
      await catalog.refresh()
      // Only announce when the list actually differs from the seed, so the
      // first paint is not disturbed by a redundant event.
      if (catalog.list().length > SEED_MODELS.length) announceModelsChanged()
    } catch (error) {
      logger.warn?.(`dsh-zen-adapter: catalogue warm-up failed: ${error?.message ?? error}`)
    }
  }
  warm()

  const refreshTimer = setInterval(() => {
    catalog
      .refresh({ force: true })
      .then(() => announceModelsChanged())
      .catch(() => {})
  }, 30 * 60 * 1000)
  refreshTimer.unref?.()

  // The detail-page bridge. `webServer` is optional: without it the adapter
  // still works, only the button has nothing to call.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (sctx) => {
        if (sctx.webServer === undefined) return
        sctx.effect(() => {
          const disposers = makeBridgeRoutes({
            catalog,
            adapter,
            providerId: PROVIDER_ID,
            logger,
            // The button's refresh must reach the picker too, or the page and
            // the menu would disagree about which models exist.
            onCatalogChanged: () => announceModelsChanged(),
          })
            .map((route) => sctx.webServer.register(route))
          return () => {
            for (const dispose of disposers) dispose()
          }
        }, 'dsh-zen-adapter: detail-page bridge')
      })
    } catch (error) {
      logger.warn?.(`dsh-zen-adapter: detail-page bridge unavailable: ${error?.message ?? error}`)
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      clearInterval(refreshTimer)
      release?.()
    })
  }
}
