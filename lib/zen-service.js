/**
 * The Zen catalogue service: one place that knows which models exist, which
 * are free, and which of those actually answer on this machine.
 *
 * Catalog membership and reachability are deliberately separate. models.dev
 * says a model is free; only a real request says whether the anonymous lane
 * will serve it from here (`muse-spark-1.3-contributor-free` is a declared
 * free model that answers `403 RegionError`). The detail page shows both, so
 * a list that looks short can be told apart from a list that is wrong.
 *
 * @module dsh-zen-adapter/zen-service
 */

import { randomBytes } from 'node:crypto'

import { buildCatalog, CACHE_TTL_MS } from './catalog.js'
import { canonicalSessionID } from './session.js'
import { UPSTREAM_BASE_URL, opencodeUserAgent, GATE_TOOL_NAME, gateTool } from './upstream.js'

/** The model used for reachability probes: small, always-on, and free. */
const PROBE_MODEL = 'space-bunny-free'

/**
 * Refreshable, probe-annotated catalogue.
 *
 * Holds the last successful snapshot so a network failure degrades to stale
 * data rather than an empty picker.
 */
export class ZenCatalogService {
  #fetchImpl
  #logger
  #snapshot = null
  #inflight = null
  #probeResults = new Map()

  constructor(options = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#logger = options.logger
  }

  /** The last built snapshot, or null before the first build. */
  get snapshot() {
    return this.#snapshot
  }

  /** Whether the current snapshot is still inside its TTL. */
  isFresh() {
    if (this.#snapshot === null) return false
    return Date.now() - this.#snapshot.fetchedAt < CACHE_TTL_MS
  }

  /**
   * Build (or reuse) the catalogue.
   *
   * Concurrent callers share one refresh: the detail page's button and the
   * adapter's startup both ask, and two simultaneous upstream calls would
   * spend the lane's per-IP quota for one answer.
   *
   * @param options - `{ force }` to ignore the TTL.
   * @returns the snapshot.
   */
  async refresh(options = {}) {
    const force = options.force === true
    if (!force && this.isFresh()) return this.#snapshot
    if (this.#inflight !== null) return this.#inflight

    this.#inflight = (async () => {
      try {
        // `maxAgeMs: 0` on a forced refresh, so the on-disk cache counts as
        // expired and both requests really go out. Without it a forced refresh
        // inside the TTL would serve the cached list and the button would
        // appear to do nothing.
        const catalog = await buildCatalog({
          fetchImpl: this.#fetchImpl,
          maxAgeMs: force ? 0 : undefined,
        })
        this.#snapshot = catalog
        this.#logger?.info?.(`dsh-zen-adapter: catalogue refreshed — ${catalog.total} on sale, ${catalog.free.length} free`)
        return catalog
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (this.#snapshot === null) {
          this.#logger?.error?.(`dsh-zen-adapter: catalogue fetch failed: ${message}`)
          throw error
        }
        // Keep serving the previous snapshot rather than emptying the picker.
        this.#logger?.warn?.(`dsh-zen-adapter: catalogue refresh failed (${message}); keeping ${this.#snapshot.free.length} cached free model(s)`)
        return { ...this.#snapshot, stale: true, refreshError: message }
      } finally {
        this.#inflight = null
      }
    })()

    return this.#inflight
  }

  /**
   * The free models, each annotated with its last probe verdict.
   *
   * @returns the models to offer, reachable ones first.
   */
  list() {
    const snapshot = this.#snapshot
    if (snapshot === null) return []
    return snapshot.free
      .map((model) => {
        const probe = this.#probeResults.get(model.id)
        return {
          ...model,
          reachable: probe === undefined ? null : probe.ok,
          probeStatus: probe?.status,
          probeDetail: probe?.detail,
          probedAt: probe?.at,
        }
      })
      .sort((a, b) => {
        // Unknown first is wrong; put known-good first, then unknown, then bad.
        const rank = (m) => (m.reachable === true ? 0 : m.reachable === null ? 1 : 2)
        return rank(a) - rank(b) || String(a.id).localeCompare(String(b.id))
      })
  }

  /** Record the outcome of one reachability probe. */
  recordProbe(id, status, detail) {
    this.#probeResults.set(id, { ok: status === 200, status, detail, at: Date.now() })
  }

  /**
   * Probe every free model with a one-token request.
   *
   * Sequential with a small delay on purpose: the anonymous lane is
   * quota-per-IP, and a burst is what earns a 429 that then looks like the
   * model being broken.
   *
   * @param options - `{ signal, onProgress }`.
   * @returns `{ checked, ok, failed }`.
   */
  async probeAll(options = {}) {
    const models = this.list()
    let ok = 0
    let failed = 0
    for (const model of models) {
      if (options.signal?.aborted) break
      const { status, detail } = await this.#probeOne(model.id, options.signal)
      this.recordProbe(model.id, status, detail)
      if (status === 200) ok += 1
      else failed += 1
      options.onProgress?.({ id: model.id, status, detail, done: ok + failed, total: models.length })
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    return { checked: ok + failed, ok, failed }
  }

  /** One reachability request, in the exact shape a chat turn uses. */
  async #probeOne(id, signal) {
    // Same generator the adapter uses. A probe that gets this wrong reports
    // 403 for every model while chat works, which reads as "upstream is down"
    // rather than "the probe is malformed".
    const session = canonicalSessionID(`zen-probe:${id}`)
    try {
      const res = await this.#fetchImpl(`${UPSTREAM_BASE_URL}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'User-Agent': opencodeUserAgent(),
          'x-opencode-client': 'cli',
          'x-opencode-session': session,
          'x-opencode-session-id': session,
          'x-opencode-request': `msg_${randomBytes(8).toString('hex')}`,
        },
        body: JSON.stringify({
          model: id,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          // The gate. Without a `read` tool the lane refuses every model,
          // including ones that answer perfectly well — a probe that omits it
          // reports 403 for models that are healthy.
          tools: [gateTool(GATE_TOOL_NAME)],
          tool_choice: 'none',
          stream: true,
          stream_options: { include_usage: true },
        }),
      })
      const body = await res.text()
      if (res.status === 200) return { status: 200, detail: '' }
      let detail = body.slice(0, 160)
      try {
        const parsed = JSON.parse(body)
        detail = parsed?.error?.type ?? parsed?.error?.message ?? detail
      } catch {}
      return { status: res.status, detail: String(detail).replace(/\s+/g, ' ') }
    } catch (error) {
      return { status: 0, detail: String(error?.message ?? error).slice(0, 160) }
    }
  }
}

export { PROBE_MODEL }
