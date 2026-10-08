/**
 * The OpenCode Zen model catalog: which models exist, which are free, and what
 * their limits are.
 *
 * Two upstream sources, because neither answers the question alone:
 *
 *   - `GET https://opencode.ai/zen/v1/models` (anonymous lane)
 *     answers **only** `{ id, object, created, owned_by }`. No price, no
 *     limits — so "is this free" cannot be read off it.
 *
 *   - `GET https://models.dev/api.json`
 *     carries `cost` (`input`/`output`) and `limit.context` per model, which
 *     is what turns an id into a free-or-paid, N-token decision.
 *
 * The live list is the authority on what is ON SALE; models.dev is the
 * authority on what it COSTS and how big it is. A model appears here only when
 * both agree, matching how opencode2dsh resolves the same problem.
 *
 * @module dsh-zen-adapter/catalog
 */

/** The anonymous lane's base; the `/v1` suffix is added at the call sites. */
export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

/** Where pricing and context limits come from. */
export const METADATA_URL = 'https://models.dev/api.json'

/** Catalogue entries older than this are refreshed on demand. */
export const CACHE_TTL_MS = 5 * 60 * 1000

/** Metadata is far more stable than the on-sale list, so it lives longer. */
export const METADATA_TTL_MS = 24 * 60 * 60 * 1000

/** The lane inspects this header, so it must look like the OpenCode CLI. */
export function opencodeUserAgent() {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

function withTimeout(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

/**
 * The on-sale model ids, in upstream order.
 *
 * @param fetchImpl - the fetch to use.
 * @param timeoutMs - bound on the whole request.
 * @returns the ids.
 * @throws when the lane answers non-200 or with an empty list.
 */
export async function fetchLiveIds(fetchImpl = fetch, timeoutMs = 30000) {
  const t = withTimeout(timeoutMs)
  try {
    const response = await fetchImpl(`${ZEN_BASE_URL.replace(/\/+$/, '')}/models`, {
      headers: {
        authorization: 'Bearer public',
        'user-agent': opencodeUserAgent(),
        'x-opencode-client': 'cli',
        accept: 'application/json',
      },
      signal: t.signal,
    })
    if (!response.ok) throw new Error(`models endpoint returned HTTP ${response.status}`)
    const payload = await response.json()
    const ids = []
    for (const item of payload?.data ?? []) {
      if (typeof item?.id === 'string' && item.id.length > 0) ids.push(item.id)
    }
    if (ids.length === 0) throw new Error('models endpoint returned an empty list')
    return ids
  } finally {
    t.done()
  }
}

/**
 * Pricing and limits for the OpenCode Zen models.
 *
 * The provider section is chosen the way opencode2dsh does it: an exact
 * `opencode` / `opencode-zen` key wins, then any key naming opencode whose own
 * `id`/`name` also says so. That ordering matters because models.dev is
 * community-maintained and carries near-miss keys (`opencode-go` is a
 * different product with different prices).
 *
 * @param fetchImpl - the fetch to use.
 * @param timeoutMs - bound on the whole request.
 * @returns a Map of model id to `{ input, output, context, maxOutput, deprecated }`.
 */
export async function fetchMetadata(fetchImpl = fetch, timeoutMs = 30000) {
  const t = withTimeout(timeoutMs)
  let data
  try {
    const response = await fetchImpl(METADATA_URL, { headers: { accept: 'application/json' }, signal: t.signal })
    if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`)
    data = await response.json()
  } finally {
    t.done()
  }

  const rank = (key) => {
    const k = String(key).toLowerCase()
    if (k === 'opencode' || k === 'opencode-zen' || k === 'opencode_zen') return 0
    if (k.includes('opencode')) return 1
    return 2
  }

  const out = new Map()
  const keys = Object.keys(data ?? {}).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  for (const key of keys) {
    if (rank(key) > 1) continue
    const provider = data[key]
    if (provider === null || typeof provider !== 'object') continue
    if (rank(key) === 1) {
      const label = `${provider.id ?? ''} ${provider.name ?? ''}`.toLowerCase().trim()
      if (!label.includes('opencode')) continue
    }
    const models = provider.models
    if (models === null || typeof models !== 'object') continue
    for (const [modelKey, raw] of Object.entries(models)) {
      if (raw === null || typeof raw !== 'object') continue
      const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : modelKey
      const cost = raw.cost ?? {}
      const limit = raw.limit ?? {}
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      const status = String(raw.status ?? raw.lifecycle ?? '').toLowerCase()
      out.set(id, {
        input: num(cost.input),
        output: num(cost.output),
        context: num(limit.context),
        maxOutput: num(limit.output),
        reasoning: raw.reasoning === true,
        deprecated:
          raw.deprecated === true ||
          status === 'deprecated' ||
          status === 'retired' ||
          status === 'disabled' ||
          raw.deprecated_at != null ||
          raw.retirement_date != null,
      })
    }
    if (out.size > 0) break
  }
  return out
}

/**
 * Decide whether one model belongs on the free lane, and why.
 *
 * Metadata is authoritative whenever it can speak: a deprecated or paid model
 * is refused even if its id ends in `-free`, because upstream keeps delisted
 * ids on sale for a while. The `-free` suffix is only a fallback for models
 * missing from models.dev (a brand-new release, typically) — the same
 * precedence opencode2dsh settled on after the delisted-id bug.
 *
 * @param id - the model id.
 * @param meta - its metadata row, if any.
 * @returns `{ free, reason, known }`.
 */
export function isFreeModel(id, meta) {
  const nameSaysFree = /free/i.test(id)
  if (meta === undefined) {
    return { free: nameSaysFree, reason: nameSaysFree ? 'name-free (no metadata)' : 'not free', known: false }
  }
  if (meta.deprecated) return { free: false, reason: 'deprecated upstream', known: true }
  if (meta.input === undefined || meta.output === undefined) {
    return { free: nameSaysFree, reason: nameSaysFree ? 'name-free (no price data)' : 'price unknown', known: false }
  }
  if (meta.input === 0 && meta.output === 0) {
    return { free: true, reason: nameSaysFree ? 'free (name + zero cost)' : 'zero cost', known: true }
  }
  return { free: false, reason: `paid (in ${meta.input} / out ${meta.output})`, known: true }
}

/**
 * Join the two sources into the catalogue the UI and the adapter both read.
 *
 * Every on-sale id is reported, including the ones that are refused, so the
 * detail page can show WHY a model is not offered — a list that silently drops
 * entries is impossible to debug from the outside.
 *
 * @param options - injectable fetch and clock.
 * @returns `{ models, free, fetchedAt, sources }`.
 */
export async function buildCatalog(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const [liveResult, metaResult] = await Promise.allSettled([fetchLiveIds(fetchImpl), fetchMetadata(fetchImpl)])

  if (liveResult.status === 'rejected') throw liveResult.reason
  const live = liveResult.value
  const meta = metaResult.status === 'fulfilled' ? metaResult.value : new Map()
  const metaError = metaResult.status === 'rejected' ? String(metaResult.reason?.message ?? metaResult.reason) : null

  const models = live.map((id) => {
    const row = meta.get(id)
    const decision = isFreeModel(id, row)
    return {
      id,
      free: decision.free,
      reason: decision.reason,
      known: decision.known,
      context: row?.context,
      maxOutput: row?.maxOutput,
      reasoning: row?.reasoning === true,
    }
  })

  return {
    models,
    free: models.filter((m) => m.free),
    fetchedAt: now(),
    total: models.length,
    metadataError: metaError,
  }
}
