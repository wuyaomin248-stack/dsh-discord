#!/usr/bin/env node
/**
 * 为自测脚本准备 @deepseek-ai/* 依赖。
 *
 * lib/index.js 会 import 三个 DSH 内部包。装进 DSH 时宿主自己解析，
 * 但在仓库目录里直接 `node load-test.mjs` 找不到它们。这个脚本把
 * 插件自己的 node_modules/@deepseek-ai/ 链到 DSH 安装目录。
 *
 *   node scripts/link-deps.mjs            # 自动探测
 *   node scripts/link-deps.mjs <DSH目录>   # 手动指定 resources/app 所在目录
 *
 * Windows 用 junction（不需要管理员权限），其他平台用 symlink。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const PKGS = ["dsh-tools", "schemastery", "cordis"];
const root = path.resolve(import.meta.dirname, "..");

function candidates() {
  const out = [];
  if (process.argv[2]) out.push(path.resolve(process.argv[2]));

  // 常见安装位置：让用户少打字
  const guesses = [
    "E:/DSH Desktop/DSH NEXT/resources/app",
    "C:/Program Files/DSH/resources/app",
    "C:/Program Files (x86)/DSH/resources/app",
    path.join(os.homedir(), "AppData/Local/Programs/DSH/resources/app"),
    "/Applications/DSH.app/Contents/Resources/app",
    "/opt/DSH/resources/app",
  ];
  out.push(...guesses);

  // 当前 profile 的 @deepseek-ai 若已解析成功，反推安装目录
  const probe = path.join(os.homedir(), ".dsh/profiles/desktop/node_modules/@deepseek-ai");
  if (fs.existsSync(probe)) out.push(path.join(probe, "..", "..", "..", ".."));

  return [...new Set(out)];
}

function hasAll(base) {
  return PKGS.every((p) => fs.existsSync(path.join(base, "node_modules/@deepseek-ai", p)));
}

let appDir = null;
for (const c of candidates()) {
  if (hasAll(c)) { appDir = c; break; }
  // 也接受直接给 @deepseek-ai 目录
  if (PKGS.every((p) => fs.existsSync(path.join(c, p)))) {
    appDir = path.join(c, "..", "..", "..");
    if (hasAll(appDir)) break;
  }
}

if (!appDir) {
  console.error("找不到 DSH 安装目录。手动指定 resources/app 那一层：");
  console.error("  node scripts/link-deps.mjs \"D:/Apps/DSH/resources/app\"");
  process.exit(1);
}

const src = path.join(appDir, "node_modules/@deepseek-ai");
const dst = path.join(root, "node_modules/@deepseek-ai");
fs.mkdirSync(dst, { recursive: true });

console.log(`DSH 安装目录: ${appDir}`);
for (const pkg of PKGS) {
  const target = path.join(src, pkg);
  const link = path.join(dst, pkg);

  if (!fs.existsSync(target)) { console.log(`  skip ${pkg}  (上游没有这个包)`); continue; }

  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink() || st.isDirectory()) { console.log(`  ok   ${pkg}  (已存在)`); continue; }
  } catch { /* 不存在，继续建 */ }

  try {
    if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "mklink", "/J", link, target], { stdio: "pipe" });
    } else {
      fs.symlinkSync(target, link, "dir");
    }
    console.log(`  link ${pkg}`);
  } catch (e) {
    console.error(`  FAIL ${pkg}: ${e.message}`);
  }
}

console.log("\n现在可以跑: node load-test.mjs");
