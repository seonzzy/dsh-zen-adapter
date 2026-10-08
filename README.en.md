# dsh-zen-adapter

Exposes the **free models** from [OpenCode Zen](https://opencode.ai/zen) to DeepSeek
Harness, registered as a native provider `zen-free`.

No signup, no API key, no extra process.

English | [简体中文](README.md)

---

## Features

- **Zero configuration** — install it, restart, and the free models show up in the model picker
- **Zero dependencies** — `dependencies` is empty; the plugin reuses the pi-ai that ships with
  DSH, so it can coexist with other provider plugins (see
  [why zero dependencies matters](#why-zero-dependencies-matters))
- **Live model catalog** — discovered from upstream at runtime, not a hard-coded list, so
  upstream model changes need no plugin update
- **Reachability checks** — separates "listed upstream" from "actually answers on this machine",
  so you don't pick a model that cannot respond
- **Built-in panel** — fetch the catalog and check reachability from the plugin's detail page,
  including context sizes

## Installation

```powershell
dsh plugin --profile <your profile> add github:seonzzy/dsh-zen-adapter
# or install from a local directory:
dsh plugin --profile <your profile> add <absolute path to this directory>
```

Restart DSH afterwards, then pick a model from the **OpenCode Zen (free lane)** group in
the model picker.

### Requirements

| Requirement | Notes |
| --- | --- |
| DSH version | A version that provides `llm.registerAdapter` and `webServer` |
| Node | ≥ 20 (bundled with DSH, nothing to install) |
| Network | Reachable `opencode.ai` and `models.dev` |

No pi-ai install, no API key, nothing for npm/pnpm to download.

## Usage

### Model picker

After installation the **OpenCode Zen (free lane)** group appears in the model picker at the
conversation input. Select any model in it to start chatting.

The catalog is **fetched dynamically**: pulled in the background at startup and refreshed
every 30 minutes.

### Plugin panel

The plugin's page under **Settings → Plugins → dsh-zen-adapter** has a panel with two buttons:

| Button | What it does |
| --- | --- |
| **获取模型** (Fetch models) | Re-pulls the model catalog from upstream |
| **检测可用性** (Check reachability) | Sends a real request per model to see which ones answer right now |

The table below them shows: model id, context size, output limit, availability status, and the
reason behind that verdict.

> **"Listed" does not mean "working".** Real-world availability of the free models depends on
> upstream endpoint health, regional restrictions, and **per-IP quotas** — all of which change
> without notice. Run **检测可用性** once in a new environment.

## Where the model list comes from

The plugin reads two upstream sources and combines them:

| Source | Provides | Does not provide |
| --- | --- | --- |
| `opencode.ai/zen/v1/models` | Ids of models currently **on sale** | Pricing, context size |
| `models.dev/api.json` | `cost`, `limit.context`, `limit.output` | Whether a model is on sale |

The second source is mandatory — Zen's `/v1/models` only returns
`{ id, object, created, owned_by }`, so **there is no way to tell from it whether a model is
free**.

The **free determination** is based on models.dev's `cost` (both `input` and `output` are 0).
Deprecated or paid models are rejected even if their id ends in `-free`, because upstream keeps
retired models in the catalog for a while. The `-free` suffix is only used as a fallback when
metadata is missing, which normally happens for freshly released models.

Context sizes and output limits also come from models.dev, so the values shown in the panel are
real numbers rather than a fixed constant.

## Why zero dependencies matters

This plugin declares **no `dependencies`**. Every `@deepseek-ai/*` and `@earendil-works/pi-ai`
package is a `peerDependencies` entry marked `optional`.

The reason: DSH's host already ships one copy of pi-ai, and the plugin resolves it along the
host's module tree, so exactly one copy exists on the machine.

If a plugin brings its own pi-ai, the machine ends up with **two pi-ai generations**. That is
not merely wasteful — some plugins (for example `dsh-workbuddy-xdpool`) verify that the host and
the plugin use the same generation, and when they don't, every single call through that provider
fails.

This plugin can therefore be installed **alongside** other provider plugins.

## Upstream limits

OpenCode's free lane is **quota'd per IP**, and some models carry **regional restrictions**.

Things you may hit:

| Symptom | Cause | What to do |
| --- | --- | --- |
| `429` | Quota exhausted or too many requests too fast | Wait a moment and retry, or switch network egress |
| `403 RegionError` | The model is not offered in your region | Cannot be worked around; pick another model |
| `5xx` / `400` | Upstream endpoint temporarily broken | Pick another model and try again later |
| Model missing from the picker | Not yet classified as free | Hit **获取模型** to refresh the catalog |

All of these are **upstream-side** behaviour that the plugin cannot fix. Use
**检测可用性** to see the current status of each model.

## Configuration

This plugin has nothing to configure. To adjust optional behaviour you can edit the constants at
the top of `lib/index.js`:

| Constant | Default | Notes |
| --- | --- | --- |
| `PROVIDER_ID` | `zen-free` | The provider id shown in DSH |
| `SEED_MODELS` | 3 models | Placeholder list used until the catalog has been fetched |
| Catalog refresh interval | 30 minutes | See `refreshTimer` in `lib/index.js` |

## Uninstall

```powershell
dsh plugin --profile <your profile> remove dsh-zen-adapter
```

Then restart DSH.

## License

MIT