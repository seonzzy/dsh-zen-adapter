#!/usr/bin/env node
/**
 * 补建已存在的 tag 对应的 GitHub Release。
 *
 * 背景：仓库里早就打了 v0.1.0 / v0.1.1 / v0.2.0 三个 tag，但一直没有建
 * Release。tag 只是 git 的一个 ref，没有可读页面、没有下载量、也不会通知
 * 订阅者——而 CHANGELOG 底部那三条 `[0.2.0]: .../releases/tag/v0.2.0`
 * 链接也因此全是死链。
 *
 * 这个脚本把三个 Release 补上，正文取自 CHANGELOG 对应段落，并给两个
 * 不可用的旧版本加上醒目警告。
 *
 * 用法：
 *
 *   $env:GITHUB_TOKEN = "ghp_xxx"     # 需要 repo scope
 *   node scripts/backfill-releases.mjs
 *   node scripts/backfill-releases.mjs --with-assets    # 顺带挂 .tgz 资产
 *
 * 需要 **Personal Access Token（classic）**，勾选 `repo` scope。
 * `public_repo` 不够——创建 Release 和上传资产都要 `repo`。
 * 仓库是公开的，但 Release 写操作仍按私有权限校验。
 *
 * 幂等：已存在的 Release 会被更新正文，不会重复创建。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractNotes } from "./release-notes.mjs";

const OWNER = "seonzzy";
const REPO = "dsh-zen-adapter";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const LATEST = "v0.2.0";

/** 每个版本正文顶部要加的话。不可用的版本必须说清楚，否则装到的人不知道该升级。 */
const PREFIX = {
	"v0.1.0":
		"> [!WARNING]\n" +
		"> **此版本完全不可用。** 每一个请求都会被上游拒绝（`403 FreeTierError`）——\n" +
		"> 会话 id 的时钟推导方式不对，上游只接受看起来像时间戳的值。\n" +
		"> 请直接安装 [v0.2.0](https://github.com/seonzzy/dsh-zen-adapter/releases/tag/v0.2.0)。\n",
	"v0.1.1":
		"> [!WARNING]\n" +
		"> **此版本同样不可用。** `403` 已经修好，但对话**每一轮**都会失败\n" +
		"> （`PI_AI_ERROR`：`Cannot read properties of undefined (reading 'apiKey')`）——\n" +
		"> provider 缺了 auth plane，pi-ai 在发请求前就抛错了。\n" +
		"> 请直接安装 [v0.2.0](https://github.com/seonzzy/dsh-zen-adapter/releases/tag/v0.2.0)。\n",
	"v0.2.0":
		"> [!NOTE]\n" +
		"> 如果你是从 v0.1.x 升上来的：那两个版本**完全不可用**（每个请求 403 / 每轮 PI_AI_ERROR），\n" +
		"> 没有需要迁移的配置，直接换到这一版即可。\n"
};

const VERSIONS = Object.keys(PREFIX);

function token() {
	const value = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (value === undefined || value === "") {
		console.error("没找到 GITHUB_TOKEN / GH_TOKEN。");
		console.error("去 https://github.com/settings/tokens/new 建一个 classic token，勾选 repo scope，然后：");
		console.error('  $env:GITHUB_TOKEN = "ghp_xxx"');
		process.exit(1);
	}
	return value;
}

async function api(path, init = {}) {
	const response = await fetch(`${API}${path}`, {
		...init,
		headers: {
			"Accept": "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "dsh-zen-adapter-release-tool",
			"Authorization": `Bearer ${token()}`,
			...init.headers
		}
	});
	if (response.status === 404) return undefined;
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}\n${text}`);
	}
	return response.json();
}

/**
 * 在临时 worktree 里对该版本打一个 npm 包。
 *
 * 不用 `git archive`：npm pack 出来的 .tgz 能直接 `dsh plugin add <file>`
 * 装，源码归档不能。npm pack 只依赖 package.json 的 files 字段，不需要
 * 装依赖，也不需要 build（dist 就是 lib/）。
 */
function packVersion(version, outDir) {
	const worktree = mkdtempSync(join(tmpdir(), "zen-release-"));
	try {
		execFileSync("git", ["worktree", "add", "--detach", worktree, version], { stdio: "pipe" });
		execFileSync("npm", ["pack", "--pack-destination", outDir], { cwd: worktree, stdio: "pipe" });
		const tarball = readdirSync(outDir).find((name) => name.endsWith(".tgz"));
		if (tarball === undefined) throw new Error(`${version}: npm pack 没有产出 .tgz`);
		return join(outDir, tarball);
	} finally {
		try {
			execFileSync("git", ["worktree", "remove", "--force", worktree], { stdio: "pipe" });
		} catch {
			rmSync(worktree, { recursive: true, force: true });
		}
	}
}

async function main() {
	const withAssets = process.argv.includes("--with-assets");
	const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
	const outDir = mkdtempSync(join(tmpdir(), "zen-assets-"));

	for (const version of VERSIONS) {
		const body = PREFIX[version] + extractNotes(version, changelog);
		const existing = await api(`/releases/tags/${version}`);

		let release;
		if (existing === undefined) {
			release = await api("/releases", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					tag_name: version,
					name: version,
					body,
					draft: false,
					prerelease: false
				})
			});
			console.log(`已创建 ${version}  ->  ${release.html_url}`);
		} else {
			release = await api(`/releases/${existing.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body })
			});
			console.log(`已更新 ${version}  ->  ${release.html_url}`);
		}

		if (withAssets) {
			const file = packVersion(version, outDir);
			const data = readFileSync(file);
			const response = await fetch(`${API}/releases/${release.id}/assets?name=${encodeURIComponent(file.split(/[\\/]/).pop())}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/gzip",
					"Authorization": `Bearer ${token()}`,
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "dsh-zen-adapter-release-tool"
				},
				body: data
			});
			if (response.ok) {
				console.log(`  已挂资产 ${file.split(/[\\/]/).pop()}`);
			} else {
				console.error(`  资产上传失败 ${response.status}: ${await response.text()}`);
			}
		}
	}

	rmSync(outDir, { recursive: true, force: true });
	console.log("");
	console.log(`完成。最新版本：https://github.com/${OWNER}/${REPO}/releases/tag/${LATEST}`);
}

await main();
