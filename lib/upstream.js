/**
 * The upstream contract, as measured on 2026-10-15.
 *
 * The anonymous free lane is still open, but the gate is not where it looks.
 * What actually decides whether a request is served:
 *
 *   1. A function tool named `read` in the body's `tools`. THIS is the gate.
 *      With it a 157-byte body is served; without it a 33 KB body carrying
 *      ten of opencode's other tools is refused. `stream: true` is required
 *      too, but pi-ai already sets it, so `read` is the one that has to be
 *      defended here.
 *   2. `stream: true` in the body. `stream: false` and a missing key are both
 *      refused.
 *   3. A `User-Agent` that reads as OpenCode, with a version number.
 *   4. Both `x-opencode-session` and `x-opencode-session-id`, same value.
 *   5. `x-opencode-client: cli`.
 *   6. The `/inference/v1` plane. `/zen/v1` is the retired path.
 *
 * What is NOT required, despite looking like it should be:
 *
 *   - No `Authorization` at all. An anonymous request is served. The lane
 *     used to want the literal string `public`; that is gone.
 *   - No credential, `oc_sk_` or otherwise. Verified twice over: emptying
 *     `~/.local/share/opencode/auth.json` does not stop the real CLI, and a
 *     request with no auth header at all is served here.
 *   - No other tools. `read` alone passes; ten names without it do not.
 *   - No long system prompt, and no particular body size.
 *   - No matching TLS fingerprint. Node 22 and the real CLI send completely
 *     different ClientHellos (48 cipher suites vs 17) and both are served.
 *
 * Those last two points are worth stating plainly, because they killed the
 * earlier "this must be a TLS or credential gate, so we have to delegate to
 * the opencode binary" theory. node passes with a fingerprint the CLI does
 * not share, and an anonymous request passes with no credential at all.
 *
 * @module dsh-zen-adapter/upstream
 */

/** Base URL. `/zen/v1` was the retired plane; this is the live one. */
export const UPSTREAM_BASE_URL = 'https://opencode.ai/inference/v1'

/**
 * The tool name the lane looks for.
 *
 * Exact, case-sensitive: `Read` is refused, `read` is not. It does not have
 * to be the only tool — any set that contains it is served — and it does not
 * need real parameters, only the name.
 */
export const GATE_TOOL_NAME = 'read'

/**
 * The gate tool, as it goes on the wire.
 *
 * Only the `name` is inspected upstream; the description and parameter schema
 * are inert placeholders that exist so the entry is a well-formed function
 * tool rather than a bare string.
 */
export function gateTool(name = GATE_TOOL_NAME) {
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
 * User-Agent. Must carry an OpenCode version; the ai-sdk and runtime tags
 * mirror what the 1.19.0 CLI sends, which is the cheapest way to stay on the
 * accepted side of the check.
 */
export function opencodeUserAgent() {
  return 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
}

/**
 * The header set the lane accepts.
 *
 * @param session - the `ses_` id; both session headers carry the same value.
 * @param request - a per-request correlation id, `msg_` prefixed.
 */
export function upstreamHeaders(session, request) {
  return {
    'User-Agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-opencode-request': request,
  }
}

/**
 * The placeholder credential pi-ai's transport layer requires.
 *
 * This is the awkward part of an anonymous lane that is reached through an
 * OpenAI-compatible client. Two independent guards demand a credential that
 * the lane itself does not want:
 *
 *   - pi-ai's `getClientApiKey()` (openai-completions.js) throws
 *     `No API key for provider: …` unless either an `apiKey` option is
 *     present or the headers already carry `authorization`.
 *   - the OpenAI SDK's `validateHeaders()` throws
 *     `Could not resolve authentication method` under the same condition.
 *
 * So SOMETHING has to occupy the field. What goes there must not look like a
 * real secret, and must not be a secret this codebase can leak: a literal
 * placeholder, the same string the lane used to accept as its own "public"
 * marker, is the honest choice.
 *
 * Verified on 2026-10-15: `Authorization: Bearer public` is served exactly as
 * often as no header at all (6/6 200s each, interleaved, 8s apart). The lane
 * ignores the value entirely; the string only satisfies the client-side
 * guards.
 *
 * NOTE this is not a credential in any sense — it is not read from the
 * environment, not stored, and grants nothing. It exists to keep the SDK's
 * auth check quiet.
 */
export const PLACEHOLDER_API_KEY = 'public'

/**
 * A pi-ai `auth.apiKey` method that resolves the placeholder.
 *
 * `createProvider()` must be handed an `auth`, because pi-ai's
 * `resolveProviderAuth()` reads `provider.auth.apiKey` unguarded the moment a
 * request carries an `apiKey` override — which the harness seam always
 * supplies. A provider built WITHOUT `auth` therefore throws
 * `Cannot read properties of undefined (reading 'apiKey')` before any
 * request goes out, while the plugin's own fetch-based probe keeps working.
 * That split — probe green, chat throwing a TypeError — is the signature of
 * this particular mistake.
 *
 * The resolver returns the placeholder as a normal api-key credential, which
 * is what lets pi-ai proceed and hand the value to the SDK.
 */
export function placeholderApiKeyAuth() {
  return {
    name: 'OpenCode Zen anonymous lane placeholder',
    resolve: async () => ({
      auth: { apiKey: PLACEHOLDER_API_KEY },
      source: 'OpenCode Zen (free lane)',
    }),
  }
}

/**
 * Whether a chat payload is shaped the way the lane requires.
 *
 * The gate is `stream: true`. Everything else in the body is the caller's.
 */
export function isLaneShaped(payload) {
  return typeof payload === 'object' && payload !== null && payload.stream === true
}
