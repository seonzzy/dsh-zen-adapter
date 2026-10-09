# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/seonzzy/dsh-zen-adapter/releases/tag/v0.1.0
