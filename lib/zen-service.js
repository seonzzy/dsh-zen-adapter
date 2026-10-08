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

import { buildCatalog, CACHE_TTL_MS } from './catalog.js'

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
        const catalog = await buildCatalog({ fetchImpl: this.#fetchImpl })
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
    const { randomBytes, createHash } = await import('node:crypto')
    const sum = createHash('sha256').update(`ses\0zen-probe:${id}`).digest()
    const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    let n = BigInt(`0x${sum.subarray(6, 16).toString('hex')}`)
    const tail = new Array(14)
    for (let i = 13; i >= 0; i--) {
      tail[i] = B62.charAt(Number(n % 62n))
      n /= 62n
    }
    const session = `ses_${sum.subarray(0, 6).toString('hex')}${tail.join('')}`
    const gate = ['bash', 'read'].map((name) => ({
      type: 'function',
      function: { name, description: 'Reserved for the host runtime; do not call it.', parameters: { type: 'object', properties: {} } },
    }))
    try {
      const res = await this.#fetchImpl('https://opencode.ai/zen/v1/chat/completions', {
        method: 'POST',
        signal,
        headers: {
          Authorization: 'Bearer public',
          'content-type': 'application/json',
          'User-Agent': `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`,
          'x-opencode-client': 'cli',
          'x-opencode-session': session,
          'x-session-affinity': session,
          'X-Session-Id': session,
          'x-opencode-request': `req_${randomBytes(8).toString('hex')}`,
          'x-opencode-project': `prj_${randomBytes(6).toString('hex')}`,
        },
        body: JSON.stringify({
          model: id,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: true,
          stream_options: { include_usage: true },
          tools: gate,
          tool_choice: 'none',
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
