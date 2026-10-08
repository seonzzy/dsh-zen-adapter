/**
 * The detail-page bridge: the HTTP surface the client half of this plugin
 * calls.
 *
 * A client plugin runs in the browser and cannot fetch upstream or read the
 * catalogue, so every action is a POST here. The route shapes and the
 * `{ ok, value | code, message }` envelope follow dsh-free-search's bridge,
 * which is the working precedent in this profile.
 *
 * @module dsh-zen-adapter/bridge
 */

/** Where the client half sends its calls. Kept in sync with `lib/client.js`. */
export const BRIDGE_PREFIX = '/api/dsh-zen-adapter'

/** Bound on what one refresh may take before it is reported as failed. */
const REFRESH_TIMEOUT_MS = 60000

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Accept only this machine's own UI.
 *
 * The bridge refreshes a catalogue and spends the anonymous lane's per-IP
 * quota, so it must not be drivable from a page the user merely visited in
 * another tab. `Sec-Fetch-Site: same-origin` is the browser's own statement
 * that the request came from our origin; a cross-site page cannot forge it.
 */
function guard(req, res) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    writeJson(res, 403, { ok: false, code: 'cross-origin', message: 'the zen bridge accepts same-origin requests only' })
    return false
  }
  return true
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** One row, as the detail page renders it. */
function toRow(model) {
  return {
    id: model.id,
    context: model.context ?? null,
    maxOutput: model.maxOutput ?? null,
    reasoning: model.reasoning === true,
    // `reachable` is null until probed: "not yet known" and "known bad" are
    // different answers and the page shows them differently.
    reachable: model.reachable,
    probeStatus: model.probeStatus ?? null,
    probeDetail: model.probeDetail ?? null,
    reason: model.reason,
  }
}

/**
 * Build this plugin's routes.
 *
 * @param deps - `{ catalog, adapter, providerId, logger, onCatalogChanged }`.
 *   `onCatalogChanged` is invoked after a catalogue change so the Host can be
 *   told the model topology moved; without it the detail page and the model
 *   picker would disagree until some unrelated host event happened to refresh
 *   the menu.
 * @returns route descriptors for `webServer.register`.
 */
export function makeBridgeRoutes(deps) {
  const { catalog, adapter, providerId, onCatalogChanged } = deps

  const snapshotPayload = (extra = {}) => {
    const snapshot = catalog.snapshot
    const models = catalog.list()
    return {
      ok: true,
      value: {
        providerId,
        models: models.map(toRow),
        free: models.length,
        total: snapshot?.total ?? 0,
        fetchedAt: snapshot?.fetchedAt ?? null,
        stale: snapshot?.stale === true,
        refreshError: snapshot?.refreshError ?? snapshot?.metadataError ?? null,
        ...extra,
      },
    }
  }

  const handlers = {
    /** Current catalogue, no upstream call. */
    async list() {
      if (catalog.snapshot === null) {
        await catalog.refresh()
      }
      return snapshotPayload()
    },

    /** Force an upstream refresh. */
    async refresh() {
      const started = Date.now()
      try {
        const timeout = new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`refresh timed out after ${REFRESH_TIMEOUT_MS}ms`)), REFRESH_TIMEOUT_MS)
          timer.unref?.()
        })
        await Promise.race([catalog.refresh({ force: true }), timeout])
      } catch (error) {
        return { ok: false, code: 'refresh-failed', message: String(error?.message ?? error) }
      }
      // Push the new list into the model picker, not just this page: the two
      // read the same catalogue through different transports, and only this
      // event makes the menu re-read it.
      try {
        onCatalogChanged?.()
      } catch {}
      const models = catalog.list()
      return snapshotPayload({ elapsedMs: Date.now() - started, changed: models.length })
    },

    /** Probe every free model for reachability. */
    async probe() {
      if (catalog.snapshot === null) await catalog.refresh()
      const summary = await catalog.probeAll({})
      // A probe changes which models are offered (unreachable ones are dropped
      // from the picker), so the menu has to be told as well.
      try {
        onCatalogChanged?.()
      } catch {}
      return snapshotPayload({ probe: summary })
    },
  }

  const routes = [
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/list`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        writeJson(res, 200, await handlers.list())
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/refresh`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: 'bad-body', message: 'malformed JSON body' })
          return
        }
        writeJson(res, 200, await handlers.refresh())
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/probe`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: 'bad-body', message: 'malformed JSON body' })
          return
        }
        writeJson(res, 200, await handlers.probe())
      },
    },
  ]

  return routes
}
