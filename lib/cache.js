/**
 * On-disk cache for the two catalogue sources.
 *
 * The two sources have wildly different sizes and volatilities, and treating
 * them the same is what made this necessary:
 *
 *   - `GET opencode.ai/inference/v1/models` returns 88 ids in ~7 KB and is
 *     answered in ~320 ms. It is the "what is on sale" authority.
 *   - `GET models.dev/api.json` returns EVERY provider's pricing in 5.69 MB,
 *     of which this plugin reads one provider's 127 rows. It takes 4-11 s
 *     locally and intermittently times out.
 *
 * Fetching the second on every startup — which is what this plugin did before
 * this module existed — meant every DSH launch paid for a 5.69 MB download
 * that was almost always going to produce the same answer.
 *
 * Two separate TTLs, because "how often" is a property of the data, not of
 * the code that reads it. The on-sale list is short-lived on purpose (a new
 * model should appear in minutes); the metadata is not, and `METADATA_TTL_MS`
 * was always meant to express exactly that — it was declared in `catalog.js`
 * and never wired up, which is what made the download unconditional.
 *
 * Storage follows the convention `dsh-free-search` already established in
 * this profile: `~/.cache/<plugin-name>/`, overridable by an environment
 * variable, deletable to clear. Nothing here registers a background job, and
 * a missing or unwritable cache directory degrades to the previous
 * network-only behaviour rather than failing the catalogue.
 *
 * @module dsh-zen-adapter/cache
 */

import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Where the cache lives unless the environment says otherwise. */
export function cacheDir() {
  return process.env.ZEN_CACHE_DIR ?? join(homedir(), '.cache', 'dsh-zen-adapter')
}

/**
 * One payload column for both tables.
 *
 * Deliberately the SAME name in both, because `readFresh`/`write` take the
 * table as a parameter and interpolate it into the SQL — a per-table column
 * name would mean the queries have to know which table they are talking to,
 * and one typo would silently disable the whole cache: the statements would
 * throw "no such column", the try/catch would swallow it, and the only
 * symptom would be that the download never stops happening.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS live_ids (
  source      TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metadata (
  source      TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
)
`

/**
 * Open the cache, or null when it cannot be opened.
 *
 * `node:sqlite` needs Node >= 22.5, and even then a read-only or locked home
 * directory can make `mkdirSync` throw. Either way the plugin keeps working
 * over the network alone — a cache is an optimisation, never a dependency.
 */
function openDatabase() {
  try {
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite')
    const dir = cacheDir()
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'catalog.db'))
    db.exec(SCHEMA)
    // `CREATE TABLE IF NOT EXISTS` cannot repair a table that already exists
    // with the wrong columns, so a schema from an earlier version of this
    // plugin would keep throwing on every read. Drop and rebuild rather than
    // serve a cache that can never be read — the data is refetched in seconds.
    for (const table of ['live_ids', 'metadata']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all()
      const names = new Set(columns.map((c) => c.name))
      if (columns.length > 0 && !names.has('payload')) {
        db.exec(`DROP TABLE ${table}`)
        db.exec(SCHEMA)
      }
    }
    return db
  } catch {
    return null
  }
}

const db = openDatabase()

/**
 * Read a cached value if it is still inside `maxAgeMs`.
 *
 * @param table - `live_ids` or `metadata`.
 * @param source - the URL the entry was fetched from.
 * @param maxAgeMs - freshness bound.
 * @returns `{ value, ageMs, stale }`, or null when there is nothing usable.
 */
function readFresh(table, source, maxAgeMs) {
  if (db === null) return null
  try {
    const row = db.prepare(`SELECT payload, fetched_at FROM ${table} WHERE source = ?`).get(source)
    if (row === undefined) return null
    const ageMs = Date.now() - Number(row.fetched_at)
    return {
      value: JSON.parse(String(row.payload)),
      ageMs,
      // A caller that wants "fresh only" ignores this; one that wants
      // "anything at all" can take it and say so in the UI.
      stale: ageMs > maxAgeMs,
    }
  } catch {
    return null
  }
}

/**
 * Write a value, replacing any previous entry for the same source.
 *
 * Returns whether the write landed. A caller that ignores the result gets the
 * old behaviour — the download keeps happening — but the result exists so a
 * future caller CAN notice, and so this function is not a silent lie.
 */
function write(table, source, value) {
  if (db === null) return false
  try {
    db.prepare(`DELETE FROM ${table} WHERE source = ?`).run(source)
    db.prepare(`INSERT INTO ${table} (source, payload, fetched_at) VALUES (?, ?, ?)`).run(
      source,
      JSON.stringify(value),
      Date.now(),
    )
    return true
  } catch {
    return false
  }
}

/**
 * The on-sale model ids.
 *
 * @param source - the URL the ids came from.
 * @param maxAgeMs - freshness bound; 5 minutes matches `CACHE_TTL_MS`.
 */
export function readLiveIds(source, maxAgeMs) {
  return readFresh('live_ids', source, maxAgeMs)
}

export function writeLiveIds(source, ids) {
  return write('live_ids', source, ids)
}

/**
 * The pricing and limit rows.
 *
 * Stored as a flat array of `[id, row]` pairs rather than an object, because
 * a Map serialises to `{}` and the ids are the whole point. `metadata.js`
 * rebuilds the Map on read.
 *
 * @param source - the metadata URL.
 * @param maxAgeMs - freshness bound; 24 hours matches `METADATA_TTL_MS`.
 */
export function readMetadata(source, maxAgeMs) {
  return readFresh('metadata', source, maxAgeMs)
}

export function writeMetadata(source, rows) {
  return write('metadata', source, rows)
}

/** Whether a cache is actually present. Lets callers skip a pointless write. */
export function cacheEnabled() {
  return db !== null
}
