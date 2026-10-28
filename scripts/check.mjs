#!/usr/bin/env node
/**
 * 离线自检：不联网、不需要 token、不需要 @deepseek-ai/* 依赖。
 * 检查仓库结构是否完整、每个源文件能否解析、工具数量是否对得上、有没有漏掉敏感信息。
 *
 *   node scripts/check.mjs
 *
 * CI 跑的就是这个。本地改完代码推之前也建议先跑一遍。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const fails = [];
const warns = [];

const fail = (m) => fails.push(m);
const warn = (m) => warns.push(m);
const ok = (m) => console.log(`  ok  ${m}`);

// ---------- 1. package.json ----------
console.log("=== 1. package.json ===");
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
} catch (e) {
  fail(`package.json 无法解析: ${e.message}`);
}
if (pkg) {
  const need = ["name", "version", "type", "main", "exports", "files", "dsh"];
  for (const k of need) if (!pkg[k]) fail(`package.json 缺字段 ${k}`);
  if (pkg.type !== "module") fail(`package.json type 必须是 module，实际 ${pkg.type}`);
  if (pkg.dsh?.bundle?.patch !== "cordis.patch.yml") fail("dsh.bundle.patch 应指向 cordis.patch.yml");
  if (!pkg.dsh?.engines?.dsh) fail("dsh.engines.dsh 缺失");
  if (!pkg.repository) warn("package.json 没有 repository 字段");
  if (!pkg.scripts) warn("package.json 没有 scripts 字段");
  ok(`name=${pkg.name} version=${pkg.version}`);
}

// ---------- 2. 必需文件 ----------
console.log("\n=== 2. 必需文件 ===");
const required = [
  "package.json", "cordis.patch.yml", "README.md", "INSTALL.md",
  "CHANGELOG.md", "LICENSE",
  "lib/index.js", "lib/api.js", "lib/token.js", "lib/search.js",
  "lib/format.js", "lib/download.js", "lib/cards.js", "lib/plugins.js",
];
for (const f of required) {
  if (!fs.existsSync(path.join(root, f))) fail(`缺文件 ${f}`);
}
if (fs.existsSync(path.join(root, ".git")) && !fs.existsSync(path.join(root, ".gitignore"))) {
  fail("Git 仓库缺少 .gitignore");
}
ok(`${required.length} 个发布必需文件齐全`);

// ---------- 3. 每个源文件能否解析 ----------
console.log("\n=== 3. 语法检查 ===");
const srcFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(e.name)) srcFiles.push(p);
  }
};
walk(root);

for (const f of srcFiles) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    fail(`语法错误 ${path.relative(root, f)}: ${String(e.stderr || e.message).split("\n")[0]}`);
  }
}
ok(`${srcFiles.length} 个 js/mjs 文件语法正确`);

// ---------- 3.5 纯函数单元测试 ----------
console.log("\n=== 3.5 单元测试 ===");
try {
  execFileSync(process.execPath, [path.join(root, "test/unit.mjs")], { stdio: "pipe" });
  ok("test/unit.mjs 全部断言通过");
} catch (e) {
  fail(`单元测试失败: ${String(e.stderr || e.message).split("\n")[0]}`);
}

// ---------- 4. 工具注册一致性 ----------
console.log("\n=== 4. 工具注册 ===");
const idx = fs.readFileSync(path.join(root, "lib/index.js"), "utf8");
// 只数注册点：ctx.tools.register(defineTool({ ... }))，别把 import 别名和包装函数算进来
const defs = (idx.match(/register\(\s*defineTool\(/g) || []).length;
const names = [...new Set([...idx.matchAll(/name:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]))]
  .filter((n) => n.startsWith("discord_"));
if (defs !== names.length) fail(`defineTool ${defs} 次，但找到 ${names.length} 个 discord_* 工具名`);
for (const n of names) {
  if (!/^discord_[a-z0-9_]+$/.test(n)) fail(`工具名不合规: ${n}`);
}
ok(`${names.length} 个工具: ${names.join(" ")}`);

// ---------- 5. 敏感信息 ----------
console.log("\n=== 5. 敏感信息扫描 ===");
const BAD = [
  [/\bghp_[A-Za-z0-9]{20,}/g, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "GitHub fine-grained token"],
  [/\bsk-[A-Za-z0-9]{20,}/g, "API key"],
  [/MTQyNTQ2[A-Za-z0-9]{6,}/g, "Discord token 前缀"],
  [/\b\d{17,19}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b/g, "Discord token 完整形态"],
  [/[A-Z]:\\Users\\[A-Za-z0-9]+/g, "本机用户路径"],
];
const textFiles = [];
const walk2 = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk2(p);
    else if (/\.(js|mjs|json|md|yml|yaml|txt)$/.test(e.name)) textFiles.push(p);
  }
};
walk2(root);

let hits = 0;
for (const f of textFiles) {
  const txt = fs.readFileSync(f, "utf8");
  for (const [re, label] of BAD) {
    for (const m of txt.matchAll(re)) {
      fail(`${label} 出现在 ${path.relative(root, f)}: ${m[0].slice(0, 40)}`);
      hits++;
    }
  }
}
if (!hits) ok(`${textFiles.length} 个文本文件无敏感信息`);

// ---------- 6. 文档一致性 ----------
console.log("\n=== 6. 文档一致性 ===");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const install = fs.readFileSync(path.join(root, "INSTALL.md"), "utf8");

const inTable = [...readme.matchAll(/^\|\s*`(discord_[a-z0-9_]+)`/gm)].map((m) => m[1]);
const missingInDoc = names.filter((n) => !inTable.includes(n));
const extraInDoc = inTable.filter((n) => !names.includes(n));
if (missingInDoc.length) fail(`README 工具表缺: ${missingInDoc.join(", ")}`);
if (extraInDoc.length) fail(`README 工具表多出（代码里没有）: ${extraInDoc.join(", ")}`);
if (!missingInDoc.length && !extraInDoc.length) ok(`README 工具表 ${inTable.length} 项与代码一致`);

for (const [file, txt] of [["README.md", readme], ["INSTALL.md", install]]) {
  for (const m of txt.matchAll(/(\d+)\s*个只读工具|(\d+)\s*个工具/g)) {
    const n = Number(m[1] || m[2]);
    if (n !== names.length) fail(`${file} 写「${n} 个工具」，实际 ${names.length} 个`);
  }
}

// 只看真正的本机绝对路径，不误伤产品名「DSH Desktop」
if (/[A-Z]:\\Users\\[A-Za-z0-9]|[A-Z]:\\DSH Desktop\\|%USERPROFILE%\\\.dsh\\(?!profiles)/.test(install)) {
  fail("INSTALL.md 含本机绝对路径");
}

// ---------- 汇总 ----------
console.log("\n" + "=".repeat(50));
if (warns.length) {
  console.log(`警告 ${warns.length} 条:`);
  for (const w of warns) console.log(`  ! ${w}`);
}
if (fails.length) {
  console.log(`失败 ${fails.length} 条:`);
  for (const f of fails) console.log(`  x ${f}`);
  process.exit(1);
}
console.log("全部通过");
