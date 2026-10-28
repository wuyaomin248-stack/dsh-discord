#!/usr/bin/env node
/**
 * 为 test/ 下的实测脚本准备 @deepseek-ai/* 依赖。
 *
 * lib/index.js 会 import 两个 DSH 内部包（dsh-tools / schemastery，cordis 可选）。
 * 装进 DSH 时宿主自己解析，但在仓库目录里直接 `node test/load.mjs` 找不到它们。
 * 这个脚本把插件自己的 node_modules/@deepseek-ai/ 链到本机已解析好的那份。
 *
 *   node scripts/link-deps.mjs                       # 自动探测
 *   node scripts/link-deps.mjs <目录>                 # 手动指定：
 *                                                    #   DSH 安装的 resources/app
 *                                                    #   或 profile 目录（含 node_modules/@deepseek-ai）
 *                                                    #   或 @deepseek-ai 目录本身
 *
 * Windows 用 junction（不需要管理员权限），其他平台用 symlink。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

// dsh-tools 是硬依赖（defineTool / validateJsonSchemaValue 都来自它）；
// schemastery 由 dsh-tools 间接需要；cordis 只是可选 peer，缺了不影响自测。
const REQUIRED = ["dsh-tools", "schemastery"];
const OPTIONAL = ["cordis"];
const root = path.resolve(import.meta.dirname, "..");

const hasAll = (base) => base && REQUIRED.every((p) => fs.existsSync(path.join(base, "node_modules/@deepseek-ai", p)));

function candidates() {
  const out = [];
  const profile = path.join(os.homedir(), ".dsh/profiles/desktop");
  if (process.argv[2]) out.push(path.resolve(process.argv[2]));
  out.push(
    // 本机常见安装位置
    "E:/DSH Desktop/DSH NEXT/resources/app",
    "C:/Program Files/DSH/resources/app",
    "C:/Program Files (x86)/DSH/resources/app",
    path.join(os.homedir(), "AppData/Local/Programs/DSH/resources/app"),
    "/Applications/DSH.app/Contents/Resources/app",
    "/opt/DSH/resources/app",
    // profile 自己解析成功的那份（最可靠：DSH 就在用它）
    profile,
  );
  return [...new Set(out)];
}

let depsDir = null; // 指向 @deepseek-ai 那一层
for (const c of candidates()) {
  if (hasAll(c)) { depsDir = path.join(c, "node_modules/@deepseek-ai"); break; }
  // 直接给的就是 @deepseek-ai 目录
  if (REQUIRED.every((p) => fs.existsSync(path.join(c, p)))) { depsDir = c; break; }
}

if (!depsDir) {
  console.error(`找不到已解析的 @deepseek-ai（需要 ${REQUIRED.join(" / ")}）。手动指定：`);
  console.error('  node scripts/link-deps.mjs "%USERPROFILE%\\.dsh\\profiles\\desktop"');
  process.exit(1);
}

const dst = path.join(root, "node_modules/@deepseek-ai");
fs.mkdirSync(dst, { recursive: true });

console.log(`依赖来源: ${depsDir}`);
for (const pkg of [...REQUIRED, ...OPTIONAL]) {
  const target = path.join(depsDir, pkg);
  const link = path.join(dst, pkg);

  if (!fs.existsSync(target)) {
    console.log(`  skip ${pkg}  (上游没有这个包${OPTIONAL.includes(pkg) ? "，可选" : ""})`);
    continue;
  }
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

console.log("\n现在可以跑: node test/load.mjs");
