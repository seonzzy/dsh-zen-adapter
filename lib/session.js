/**
 * OpenCode session identifiers.
 *
 * The free lane does not merely check that a session id LOOKS like OpenCode's —
 * it decodes the 12 hex characters and checks they are a plausible wall clock.
 * A regex match is therefore not evidence of correctness, which is what makes
 * this failure mode so quiet: every shape assertion still passes while every
 * request is refused.
 *
 * Upstream's own generator (`packages/schema/src/identifier.ts`) is:
 *
 *     const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
 *     const value   = descending ? ~current : current   // sessions descend
 *     // take 6 bytes of `value` -> 12 lowercase hex
 *
 * The bitwise NOT is what puts the clock in the high bits and the counter in
 * the low ones, and the low bits end up looking like the `ffe` suffix people
 * keep mistaking for a sentinel: `~1` ends in `ffe`, `~2` in `ffd`, `~300` in
 * `ed3`. Hard-coding that suffix yields a number that is still not a clock, so
 * it fails on the next attempt. This module reproduces the arithmetic instead.
 *
 * @module dsh-zen-adapter/session
 */

import { createHash } from 'node:crypto'

/** OpenCode's Base62 alphabet: digits, then uppercase, then lowercase. */
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** The shape the lane accepts: `ses_` + 12 lowercase hex + 14 Base62. */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/** How many bits of the counter are folded into the timestamp. */
const COUNTER_SHIFT = 0x1000n

/**
 * The 12 hex characters upstream decodes as a clock.
 *
 * `~/current` is taken deliberately: it is the inverse of the value, and the
 * decoder upstream inverts it back. Computing this from the digest instead —
 * as this plugin originally did — produces a string of the right shape whose
 * decoded value is a nonsense date, which the lane treats as "not OpenCode".
 *
 * @param timestamp - milliseconds since epoch.
 * @param counter - per-millisecond discriminator; 1 is the first id of a ms.
 * @returns 12 lowercase hex characters.
 */
export function clockHex(timestamp, counter = 1) {
  const current = BigInt(timestamp) * COUNTER_SHIFT + BigInt(counter)
  const value = ~current
  const bytes = new Array(6)
  let remaining = value
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The 14 Base62 characters that follow the clock part.
 *
 * These carry no gate meaning — upstream only decodes the leading 12 hex — but
 * they must be Base62 and are derived from `seed` so that a conversation keeps
 * a stable identity across turns, which is what session affinity and prompt
 * caching key on.
 *
 * @param seed - anything stable for the conversation.
 * @returns 14 Base62 characters.
 */
export function base62Tail(seed) {
  const digest = createHash('sha256').update(String(seed)).digest()
  let value = BigInt(`0x${digest.subarray(6, 16).toString('hex')}`)
  const out = new Array(14)
  for (let i = 13; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(value % 62n))
    value /= 62n
  }
  return out.join('')
}

/**
 * A session id the free lane accepts.
 *
 * @param seed - stable per-conversation input, used for the Base62 tail only.
 * @param options - `{ timestamp, counter }` for tests.
 * @returns `ses_` + clock hex + Base62 tail.
 */
export function canonicalSessionID(seed, options = {}) {
  const timestamp = options.timestamp ?? Date.now()
  const counter = options.counter ?? 1
  return `ses_${clockHex(timestamp, counter)}${base62Tail(seed)}`
}

/** Whether `id` matches the shape the lane documents. */
export function isCanonicalSessionID(id) {
  return typeof id === 'string' && CANONICAL_SESSION_PATTERN.test(id)
}

export { CANONICAL_SESSION_PATTERN, BASE62_ALPHABET }
