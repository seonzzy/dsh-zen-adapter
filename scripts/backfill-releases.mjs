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
 *   node scripts/backfill-releases.mjs --token-file /path/to/token.txt
 *
 * `--token-file` 从文件读 token，优先级高于环境变量。走文件比走命令行好：
 * 命令行会进 shell 历史，文件不会。
 *
 * 需要 **Personal Access Token（classic）**，勾选 `repo` scope。
 * `public_repo` 不够——创建 Release 和上传资产都要 `repo`。
 * 仓库是公开的，但 Release 写操作仍按私有权限校验。
 *
 * 幂等：已存在的 Release 会被更新正文，不会重复创建。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

let cachedToken;

/**
 * 取 token。
 *
 * 优先 `--token-file`（内容 trim 掉尾随换行），其次环境变量。
 * 结果缓存起来：每次 API 调用都读一次文件没有必要。
 */
function token() {
	if (cachedToken !== undefined) return cachedToken;

	const fileIndex = process.argv.indexOf("--token-file");
	if (fileIndex !== -1) {
		const file = process.argv[fileIndex + 1];
		if (file === undefined) {
			console.error("--token-file 后面要跟文件路径。");
			process.exit(1);
		}
		if (!existsSync(file)) {
			console.error(`token 文件不存在：${file}`);
			process.exit(1);
		}
		cachedToken = readFileSync(file, "utf8").trim();
	} else {
		cachedToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	}

	if (cachedToken === undefined || cachedToken === "") {
		console.error("没找到 token。");
		console.error("两种方式任选其一：");
		console.error('  $env:GITHUB_TOKEN = "ghp_xxx"');
		console.error("  node scripts/backfill-releases.mjs --token-file <文件路径>");
		console.error("");
		console.error("token 需要 classic PAT 且勾选 repo scope：");
		console.error("https://github.com/settings/tokens/new");
		process.exit(1);
	}
	return cachedToken;
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
 * npm 的可执行文件名。
 *
 * Windows 上 PATH 里只有 `npm.cmd`（没有 npm.exe），而 CreateProcess 不做
 * PATHEXT 展开——直接 spawn "npm" 会 ENOENT。必须显式带 .cmd。
 */
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * 在临时 worktree 里对该版本打一个 npm 包。
 *
 * 不用 `git archive`：npm pack 出来的 .tgz 能直接 `dsh plugin add <file>`
 * 装，源码归档不能。npm pack 只依赖 package.json 的 files 字段，不需要
 * 装依赖，也不需要 build（dist 就是 lib/）。
 *
 * 每个版本用**独立的**打包目录：三个版本依次 pack 到同一个目录时，
 * 按目录里"第一个 .tgz"取产物会拿到上一个版本的包。
 *
 * Windows 上必须带 shell：Node 不允许 execFile 直接执行 .cmd（EINVAL），
 * 而 npm 只有 npm.cmd。参数里的路径来自 mkdtemp，不含用户输入，没有
 * 命令注入面。
 */
function packVersion(version, outDir) {
	const worktree = mkdtempSync(join(tmpdir(), "zen-release-"));
	const packDir = mkdtempSync(join(tmpdir(), "zen-pack-"));
	const expected = `dsh-zen-adapter-${version.replace(/^v/, "")}.tgz`;
	try {
		execFileSync("git", ["worktree", "add", "--detach", worktree, version], { stdio: "pipe" });
		try {
			execFileSync(NPM, ["pack", "--pack-destination", packDir], {
				cwd: worktree,
				stdio: "pipe",
				shell: process.platform === "win32"
			});
		} catch (error) {
			// npm pack 失败不致命：退到 git archive，至少让 download_count 有数可计。
			console.error(`  ${version}: npm pack 失败（${error.code ?? error.message}），改用 git archive`);
			execFileSync("git", ["archive", "--format=tar.gz", "-o", join(packDir, expected), version], { stdio: "pipe" });
		}

		// 精确按版本号取产物，不靠"目录里第一个 tgz"。
		const produced = join(packDir, expected);
		if (!existsSync(produced)) {
			throw new Error(`${version}: 期望产出 ${expected}，实际有 ${readdirSync(packDir).join(", ") || "(空)"}`);
		}
		const target = join(outDir, expected);
		copyFileSync(produced, target);
		return target;
	} finally {
		try {
			execFileSync("git", ["worktree", "remove", "--force", worktree], { stdio: "pipe" });
		} catch {
			rmSync(worktree, { recursive: true, force: true });
		}
		rmSync(packDir, { recursive: true, force: true });
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
			const filename = file.split(/[\\/]/).pop();

			// 上传走 uploads.github.com，不是 api.github.com。
			// upload_url 形如 https://uploads.github.com/repos/<owner>/<repo>/releases/<id>/assets{?name,label}，
			// 把 {?name,label} 模板部分切掉，再自己拼查询串。
			// 拿 api.github.com 拼上传路径会得到 404——两者是不同 host。
			const uploadUrl = release.upload_url.replace(/\{.*$/, "");
			const response = await fetch(`${uploadUrl}?name=${encodeURIComponent(filename)}`, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${token()}`,
					"Accept": "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "dsh-zen-adapter-release-tool",
					"Content-Type": "application/gzip",
					"Content-Length": String(data.byteLength)
				},
				body: data
			});
			if (response.ok) {
				console.log(`  已挂资产 ${filename}`);
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
