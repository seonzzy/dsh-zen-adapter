# dsh-zen-adapter

把 [OpenCode Zen](https://opencode.ai/zen) 的**免费模型**接入 DeepSeek Harness，
注册为原生 provider `zen-free`。

无需注册、无需 API key、无需额外进程。

**English** | 简体中文

---

## 特性

- **零配置** — 装上、重启、就能在模型选择器里选到免费模型
- **零依赖** — `dependencies` 为空，运行时复用 DSH 自带的 pi-ai，因此可以和其他
  provider 插件共存（详见[为什么零依赖很重要](#为什么零依赖很重要)）
- **动态模型目录** — 从上游实时发现，不是写死的清单，上游换模型不用等插件更新
- **可用性检测** — 区分「目录里在售」和「这台机器真的能调通」，避免选到用不了的模型
- **可视化面板** — 在插件详情页一键获取模型、检测可用性，并查看上下文大小

## 安装

```powershell
dsh plugin --profile <你的 profile> add github:seonzzy/dsh-zen-adapter
# 或从本地目录安装：
dsh plugin --profile <你的 profile> add <本目录绝对路径>
```

装完**重启 DSH**，然后在模型选择器里选择 **OpenCode Zen (free lane)** 分组下的模型。

### 前提条件

| 条件 | 说明 |
| --- | --- |
| DSH 版本 | 需要带 `llm.registerAdapter` 与 `webServer` 的版本 |
| Node | ≥ 20（DSH 自带，无需另装）|
| 网络 | 能访问 `opencode.ai` 与 `models.dev` |

不需要安装 pi-ai、不需要 API key、不需要 npm/pnpm 下载任何东西。

## 使用

### 模型选择器

安装后在对话输入框的模型选择器里会出现 **OpenCode Zen (free lane)** 分组，
选择其中一个模型即可开始对话。

目录会**动态获取**：启动时后台拉取，之后每 30 分钟自动刷新一次。

### 插件面板

在「设置 → 插件 → dsh-zen-adapter」页面上有一个面板：

| 按钮 | 作用 |
| --- | --- |
| **获取模型** | 从上游重新拉取模型目录 |
| **检测可用性** | 逐个真实请求，测出哪些模型当前可用 |

下面的表格展示：模型名、上下文大小、输出上限、可用状态、判定依据。

> **「目录里有」不等于「能用」。** 免费模型的实际可用性受上游端点状态、
> 地区限制、以及**按 IP 计的配额**影响，随时会变。建议在新环境里点一次
> 「检测可用性」。

## 模型是怎么来的

插件同时读取两个上游数据源，取交集：

| 源 | 提供 | 不提供 |
| --- | --- | --- |
| `opencode.ai/zen/v1/models` | 当前**在售**的模型 id | 价格、上下文 |
| `models.dev/api.json` | `cost`、`limit.context`、`limit.output` | 是否在售 |

第二个源是必需的——Zen 的 `/v1/models` 只返回 `{ id, object, created, owned_by }`，
**无法从它判断某模型是否免费**。

**免费判定**以 models.dev 的 `cost` 为准（`input` 与 `output` 均为 0）。
已弃用或收费的模型即使 id 带 `-free` 也不会放行——上游会把下架模型在目录里
继续挂一段时间。只有 metadata 缺失时（通常是刚发布的新模型）才退回看 `-free` 后缀。

上下文大小与输出上限同样来自 models.dev，所以界面上显示的是真实数值，
不是某个固定常数。

## 为什么零依赖很重要

本插件**不声明任何 `dependencies`**，`@deepseek-ai/*` 与 `@earendil-works/pi-ai`
全部声明为 `peerDependencies` 且标记 `optional`。

原因：DSH 宿主自带一份 pi-ai，插件运行时沿宿主的模块树解析，全局始终只有一份。

如果插件自带一份 pi-ai，机器上就会出现**两个 pi-ai 世代**。这不只是冗余——
某些插件（例如 `dsh-workbuddy-xdpool`）会校验宿主与插件用的是不是同一世代，
不一致时整个 provider 每次调用都会失败。

因此本插件可以和其他 provider 插件**同时安装**。

## 上游限制

OpenCode 的免费通道**按 IP 计配额**，部分模型还有**地区限制**。

可能遇到的情况：

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `429` | 配额用尽或请求过密 | 等一会儿再试，或换网络节点 |
| `403 RegionError` | 该模型不对你所在地区开放 | 无法绕过，换其他模型 |
| `5xx` / `400` | 上游端点暂时故障 | 换其他模型，稍后再试 |
| 模型不在选择器里 | 尚未被判定为免费 | 点「获取模型」刷新目录 |

这些都属于**上游侧**行为，插件无法修复。用「检测可用性」可以看到每个模型的
当前状态。

## 配置

本插件没有需要配置的选项。如需调整可选行为，可修改 `lib/index.js` 顶部的常量：

| 常量 | 默认 | 说明 |
| --- | --- | --- |
| `PROVIDER_ID` | `zen-free` | 在 DSH 中显示的 provider id |
| `SEED_MODELS` | 3 个模型 | 目录拉取完成前的占位列表 |
| 目录刷新间隔 | 30 分钟 | 见 `lib/index.js` 中的 `refreshTimer` |

## 卸载

```powershell
dsh plugin --profile <你的 profile> remove dsh-zen-adapter
```

然后重启 DSH。

## 许可

MIT
