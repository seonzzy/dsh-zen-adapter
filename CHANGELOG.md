# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-13

### Fixed

- **Free lane rejected every request with `403 FreeTierError`.** The session id
  sent upstream was well-shaped but derived wrongly: its 12 hex characters came
  from a SHA-256 digest, while the lane decodes them as a **bit-inverted wall
  clock** and refuses anything that is not a plausible timestamp. Every request
  failed, including ones that previously worked, while the catalog stayed
  readable — so the plugin looked healthy and simply could not talk.

  The clock part is now produced with upstream's own arithmetic
  (`BigInt(timestamp) * 0x1000n + counter`, then `~`, taking 6 bytes), in a new
  `lib/session.js` shared by the adapter and the availability probe.

  Two consequences worth recording, because both mislead:

  - **A shape match proves nothing.** `/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/`
    accepts the broken ids, so no shape assertion could have caught this.
  - **`ffe` is not a token.** Ids that end in `ffe` happen to work when
    `counter` is 1, because `~1` ends in `ffe`; `~2` ends in `ffd` and `~300`
    in `ed3`. Hard-coding the suffix still yields a digest, not a clock.

- **The availability probe generated its own session id** — a second copy of the
  same broken derivation. The probe button would have reported `403` for every
  model while chat worked, which reads as "upstream is down" rather than "the
  probe is malformed". Both call sites now share one implementation.

### Notes

- Verified against the live lane with the plugin's own code path
  (`ZenCatalogService.probeAll()`): 5 of 10 advertised free models answer.
  The remaining failures are upstream-side and are expected —
  `ling-3.1-flash-free` and `step-5-preview-free` throttle (`429`),
  `jev-1.13-free` is SystemOne-only (`400 ModelProtocolUnsupported`),
  `muse-spark-1.3-contributor-free` is region-blocked (`403 RegionError`).
- A wrong recipe for this outage circulated publicly (switch to
  `/inference/openai`, drop `Authorization`, add a `shell` tool). It does not
  work: the gate is the session id, not the endpoint, the auth header, or the
  tool names.

## [0.1.0] - 2026-10-08

Initial release.

### Added

- **Native DSH provider `zen-free`** — OpenCode Zen's free models registered
  through `llm.registerAdapter()`, so they appear in the model picker as the
  **OpenCode Zen (free lane)** group. No signup, no API key, no extra process.
- **Live model catalog** — the free roster is discovered at runtime from
  `opencode.ai/zen/v1/models` intersected with `models.dev/api.json`, rather
  than hard-coded. Refreshed in the background every 30 minutes, and a refresh
  is announced to the client so the picker updates without a restart.
- **Free determination from pricing** — a model is offered only when
  models.dev reports `input` and `output` cost of 0. Deprecated or paid models
  are refused even when their id ends in `-free`, because upstream keeps
  delisted ids on sale for a while. The `-free` suffix is a fallback used only
  when metadata is missing altogether.
- **Real context limits** — `contextWindow` and `maxTokens` come from
  models.dev per model instead of a fixed constant, so a 1M-token model is not
  understated and a 200K model is not overstated.
- **Plugin detail page** — a panel under **Settings → Plugins → dsh-zen-adapter**
  with **获取模型** (re-pull the catalog) and **检测可用性** (send a real request
  per model to see which ones answer right now), plus a table of model id,
  context size, output limit, availability status and the reason behind it.
- **Zero dependencies** — `@deepseek-ai/*` and `@earendil-works/pi-ai` are
  declared as optional `peerDependencies` and resolved through the host's
  module tree, so exactly one pi-ai generation exists on the machine and the
  plugin can be installed alongside other provider plugins.

### Notes

- Upstream availability is **per-IP quota'd**, and some models carry regional
  restrictions. A model being listed does not mean it will answer: `429`,
  `403 RegionError` and `5xx` are upstream-side behaviour this plugin cannot
  fix. Use **检测可用性** to see current status.
- `PROVIDER_ID` is deliberately `zen-free` rather than `zen`, because
  `llm.registerAdapter()` is all-or-nothing and a second claimant of an
  existing provider id throws `DUPLICATE_ADAPTER`.

[0.1.1]: https://github.com/seonzzy/dsh-zen-adapter/releases/tag/v0.1.1
[0.1.0]: https://github.com/seonzzy/dsh-zen-adapter/releases/tag/v0.1.0
