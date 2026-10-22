#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 抽出某个版本的段落，用作 GitHub Release 的正文。
 *
 *   node scripts/release-notes.mjs v0.2.0     # 打到 stdout
 *   node scripts/release-notes.mjs 0.2.0      # v 前缀可省
 *
 * 抽的是 `## [0.2.0] - 2026-10-16` 到下一个 `## [` 之间的内容。
 *
 * 为什么过滤掉 `[0.2.0]: https://...` 那种行：那是 Keep a Changelog 的
 * 引用式链接定义，只对 CHANGELOG 自己有意义。贴进 Release 之后它会变成
 * 一个悬空链接（Release 页面没有这些锚点），而且每个版本都会重复一份。
 *
 * 同一个文件被 release.yml 和 backfill-releases.mjs 共用：一边给将来的
 * tag 自动发布用，一边给已经打好 tag 的历史版本补建 Release 用。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHANGELOG = join(here, "..", "CHANGELOG.md");

/** 版本号里的 `.` `+` 等在正则里要转义，否则 0.2.0 会匹配成 "0X2X0"。 */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 抽出 CHANGELOG 里某个版本的正文。
 *
 * @param {string} version 版本号，`v` 前缀可有可无
 * @param {string} changelog CHANGELOG.md 全文
 * @returns {string} 该版本的正文（不含 `## [x.y.z]` 标题行）
 */
export function extractNotes(version, changelog) {
	const bare = version.replace(/^v/, "");
	const lines = changelog.split(/\r?\n/);

	const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[${escapeRegExp(bare)}\\]`).test(line));
	if (start === -1) {
		const known = [...changelog.matchAll(/^##\s+\[([^\]]+)\]/gm)].map((m) => m[1]);
		throw new Error(`CHANGELOG.md 里没有版本 ${version}。现有版本：${known.join(", ")}`);
	}

	// 段落结束于下一个版本标题（`## [x.y.z]`），不是任意 `##`——否则
	// `### Fixed` 这种小节标题会被误当成边界。
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s+\[/.test(lines[i])) {
			end = i;
			break;
		}
	}

	return lines
		.slice(start + 1, end)
		.filter((line) => !/^\[[^\]]+\]:\s/.test(line))
		.join("\n")
		.replace(/^\n+/, "")
		.replace(/\s+$/, "");
}

/** 命令行用法：读文件、抽版本、打到 stdout。 */
function main() {
	const version = process.argv[2];
	if (version === undefined || version === "") {
		console.error("用法: node scripts/release-notes.mjs <版本号>");
		process.exitCode = 1;
		return;
	}
	const notes = extractNotes(version, readFileSync(CHANGELOG, "utf8"));
	if (notes === "") {
		console.error(`版本 ${version} 的段落是空的。`);
		process.exitCode = 1;
		return;
	}
	console.log(notes);
}

// 直接运行时才跑 main()；被 import 时只导出函数。
// 不用 import.meta.url 比较——Windows 上盘符大小写与分隔符会让它对不上。
if (process.argv[1] !== undefined && process.argv[1].replace(/\\/g, "/").endsWith("release-notes.mjs")) {
	main();
}
