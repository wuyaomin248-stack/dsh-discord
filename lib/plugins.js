/**
 * 插件（extension / script）发现与判型。
 *
 * 跟角色卡完全不同的一套东西：
 *   角色卡 → PNG/JSON 里内嵌 chara/ccv3 数据块
 *   插件   → zip 包里有 manifest.json + index.js，或单个 .json 脚本
 *
 * 而且插件的发布形态很散（实测 25 个插件帖）：
 *   14/25  正文放 GitHub/Gitee 链接，没有附件
 *    2/25  回复里挂 zip
 *   12/25  首帖只有截图和描述，得翻回复
 * 所以找插件要同时扫「正文链接」和「回复附件」。
 */
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import { getMessages, getGuildChannels, apiGet } from "./api.js";
import { downloadAttachment } from "./download.js";
import { fetchStarter } from "./cards.js";

/** 酒馆插件的标志文件：有 manifest 基本就是扩展。 */
const EXT_MARKERS = ["manifest.json", "index.js"];

/** 脚本类（酒馆助手脚本）常见形态：单个 .json，里面有 name/content。 */
const SCRIPT_EXTS = [".json"];

/** 包类：.zip。 */
const ARCHIVE_EXTS = [".zip"];

/** 版本托管站，正文出现这些说明插件源码在外面。 */
const REPO_HOSTS = /(github\.com|gitee\.com|greasyfork\.org|gitlab\.com|codeberg\.org)/i;

/**
 * 手工解析 zip 中央目录。
 *
 * 不引第三方库：只需要文件名列表来判断是不是插件包，
 * 解压内容反而没必要（我们不执行、也不读源码）。
 */
export function listZipEntries(buf) {
  if (buf.length < 22 || buf.toString("latin1", 0, 2) !== "PK") return null;
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const total = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < total; i += 1) {
    if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== 0x02014b50) break;
    const nl = buf.readUInt16LE(cd + 28);
    const el = buf.readUInt16LE(cd + 30);
    const cl = buf.readUInt16LE(cd + 32);
    const raw = buf.readUInt32LE(cd + 24);
    if (cd + 46 + nl > buf.length) break;
    entries.push({
      name: buf.toString("utf8", cd + 46, cd + 46 + nl),
      size: raw,
    });
    cd += 46 + nl + el + cl;
  }
  return entries;
}

/**
 * 判定一个下载下来的文件是不是酒馆插件。
 *
 * 返回 { ok, kind, name, why, ... }
 *   kind: extension（zip 带 manifest）| script（单 json 脚本）| unknown
 */
export function inspectPlugin(buf, filename = "") {
  const lower = String(filename).toLowerCase();

  // ---- zip 包 ----
  if (lower.endsWith(".zip") || buf.toString("latin1", 0, 2) === "PK") {
    const entries = listZipEntries(buf);
    if (!entries) {
      return { ok: false, kind: "unknown", why: "不是可解析的 zip", size: buf.length };
    }
    const names = entries.map((e) => e.name.toLowerCase());
    const base = (p) => p.split("/").pop();
    const hasManifest = names.some((n) => base(n) === "manifest.json");
    const hasIndex = names.some((n) => base(n) === "index.js");
    const jsCount = names.filter((n) => n.endsWith(".js")).length;

    if (!hasManifest && !hasIndex && jsCount === 0) {
      return {
        ok: false,
        kind: "zip",
        why: `zip 里没有插件特征文件（${entries.length} 个文件，0 个 js）`,
        size: buf.length,
        fileCount: entries.length,
      };
    }

    // 顶层目录名常就是插件名
    const roots = new Set(
      entries.map((e) => e.name.split("/")[0]).filter((r) => r && !r.includes("."))
    );
    const name =
      roots.size === 1 ? [...roots][0] : filename.replace(/\.zip$/i, "");

    // 读 manifest 拿 display_name（有就更好）
    let displayName = null;
    if (hasManifest) {
      try {
        const mf = entries.find((e) => base(e.name.toLowerCase()) === "manifest.json");
        const data = extractZipEntry(buf, mf.name);
        if (data) {
          const j = JSON.parse(data.toString("utf8"));
          displayName = j.display_name || j.name || null;
        }
      } catch {
        /* 读不出名字不影响判定 */
      }
    }

    return {
      ok: true,
      kind: "extension",
      name: displayName || name,
      packageName: name,
      fileCount: entries.length,
      jsCount,
      hasManifest,
      hasIndex,
      size: buf.length,
    };
  }

  // ---- 单个 .json 脚本 ----
  if (lower.endsWith(".json")) {
    let j;
    try {
      j = JSON.parse(buf.toString("utf8"));
    } catch {
      return { ok: false, kind: "unknown", why: "JSON 解析失败", size: buf.length };
    }
    // 酒馆助手脚本：name + content（content 是 JS 源码）
    const isScript =
      typeof j.name === "string" &&
      typeof j.content === "string" &&
      j.content.length > 0;
    if (isScript) {
      // 脚本内部还常带 info/type，一并带出来，便于判断用途
      const info = j.info && typeof j.info === "object" ? j.info : null;
      return {
        ok: true,
        kind: "script",
        name: j.name,
        contentLen: j.content.length,
        enabled: j.enabled ?? null,
        scriptType: j.type ?? null,
        ...(info?.description ? { description: String(info.description).slice(0, 200) } : {}),
        ...(info?.author ? { scriptAuthor: String(info.author).slice(0, 80) } : {}),
        ...(info?.version ? { version: String(info.version).slice(0, 40) } : {}),
        size: buf.length,
      };
    }
    // 也可能是 MVU 变量 / 预设这类数据文件，不算插件
    const keys = Object.keys(j).slice(0, 6).join(", ");
    return {
      ok: false,
      kind: "json",
      why: `JSON 但不是酒馆助手脚本（字段：${keys}）`,
      size: buf.length,
    };
  }

  return {
    ok: false,
    kind: "other",
    why: `不支持的类型（${filename}）`,
    size: buf.length,
  };
}

/** 从 zip 里取出某个文件的内容（只支持 stored / deflate，够用）。 */
function extractZipEntry(buf, wantName) {
  const entries = listZipEntries(buf);
  if (!entries) return null;
  const idx = entries.findIndex((e) => e.name === wantName);
  if (idx < 0) return null;

  // 重新走一遍本地文件头，取压缩数据
  let cd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { cd = buf.readUInt32LE(i + 16); break; }
  }
  if (cd < 0) return null;
  let p = cd;
  for (let i = 0; i < entries.length; i += 1) {
    if (i === idx) {
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const nl = buf.readUInt16LE(p + 28);
      const el = buf.readUInt16LE(p + 30);
      const cl = buf.readUInt16LE(p + 32);
      const lho = buf.readUInt32LE(p + 42);
      // 本地头：30 + nameLen + extraLen 之后就是数据
      const lnl = buf.readUInt16LE(lho + 26);
      const lel = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnl + lel;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) {
        try {
          return zlib.inflateRawSync(data);
        } catch {
          return null;
        }
      }
      return null;
    }
    const nl = buf.readUInt16LE(p + 28);
    const el = buf.readUInt16LE(p + 30);
    const cl = buf.readUInt16LE(p + 32);
    p += 46 + nl + el + cl;
  }
  return null;
}

/**
 * 从一个插件帖里收集所有可能的获取方式。
 *
 * 返回 { links, files, hasRepo, hasArchive }
 */
export function scanThreadForPlugin(starter, replies = []) {
  const links = new Set();
  const files = [];

  const collectLinks = (text) => {
    for (const l of String(text || "").match(/https?:\/\/[^\s)>\]]+/g) || []) {
      // 频道内跳转不算下载源
      if (/discord\.com\/channels\//.test(l)) continue;
      links.add(l.replace(/[.,;:]+$/, ""));
    }
  };

  collectLinks(starter?.content);
  for (const e of starter?.embeds || []) {
    collectLinks(e.url);
    collectLinks(e.description);
  }
  // 主帖附件里的截图不算插件，但 zip/json 算
  for (const a of starter?.attachments || []) {
    if (/\.(zip|json|js|txt)$/i.test(a.filename)) files.push({ ...a, where: "starter" });
  }

  for (const m of replies) {
    collectLinks(m.content);
    for (const a of m.attachments || []) {
      if (/\.(zip|json|js|txt)$/i.test(a.filename)) {
        files.push({
          ...a,
          where: "reply",
          replyAuthor: m.author?.global_name || m.author?.username,
          replyNote: (m.content || "").slice(0, 200),
        });
      }
    }
  }

  const linkList = [...links];
  return {
    links: linkList,
    repoLinks: linkList.filter((l) => REPO_HOSTS.test(l)),
    files,
    hasRepo: linkList.some((l) => REPO_HOSTS.test(l)),
    hasArchive: files.some((f) => /\.zip$/i.test(f.filename)),
  };
}

/**
 * 列一个论坛频道里的插件帖。
 *
 * 普通用户拿不到「活跃帖子」列表（bot 专用），只能通过
 * threads/archived/public 拿已归档的，或靠推送消息里的传送门。
 */
export async function listForumThreads(token, forumId, { pages = 2 } = {}) {
  const out = [];
  let before;
  for (let p = 0; p < pages; p += 1) {
    let res;
    try {
      res = await apiGet(token, `/channels/${forumId}/threads/archived/public`, {
        limit: 25,
        ...(before ? { before } : {}),
      });
    } catch {
      break;
    }
    const batch = res.threads || [];
    out.push(...batch);
    if (!res.has_more || !batch.length) break;
    before = batch[batch.length - 1].thread_metadata?.archive_timestamp;
    if (!before) break;
  }
  return out;
}

/**
 * 把一个插件帖解析成可验证的候选。
 *
 * 优先回复里的 zip/json（能直接下），没有就返回仓库链接（要用户自己去 clone）。
 */
export async function resolvePluginThread(token, threadId, { replyLimit = 50 } = {}) {
  const starter = await fetchStarter(token, threadId);
  let replies = [];
  try {
    replies = await getMessages(token, threadId, { limit: replyLimit });
  } catch {
    /* 读不到回复不影响主帖扫描 */
  }
  const scanned = scanThreadForPlugin(starter, replies);
  return { starter, replies, ...scanned };
}

/**
 * 验证一批插件文件。下载后判型，不保留文件。
 */
export async function verifyPluginFiles(files, { maxCheck = 15, onProgress } = {}) {
  const verified = [];
  const rejected = [];
  let checked = 0;

  for (const f of files) {
    if (checked >= maxCheck) break;
    checked += 1;
    try {
      const r = await downloadAttachment(f.url, {
        dir: os.tmpdir(),
        filename: `p-${checked}-${f.filename}`,
        maxBytes: 60 * 1024 * 1024,
        inspect: false,
      });
      const buf = fs.readFileSync(r.path);
      const verdict = inspectPlugin(buf, f.filename);
      try { fs.unlinkSync(r.path); } catch { /* */ }
      if (verdict.ok) {
        verified.push({ ...f, plugin: verdict });
        onProgress?.(`✓ [${verdict.kind}] ${verdict.name || f.filename}`);
      } else {
        rejected.push({ ...f, why: verdict.why });
        onProgress?.(`✗ ${f.filename} — ${verdict.why}`);
      }
    } catch (e) {
      rejected.push({ ...f, why: e.message });
      onProgress?.(`✗ ${f.filename} — ${e.message}`);
    }
  }
  return { verified, rejected, checked };
}

/**
 * 找服务器里像「插件区」的频道。
 */
export async function pluginChannels(token, guildId, pattern) {
  const chs = await getGuildChannels(token, guildId);
  const re = pattern ? new RegExp(pattern, "i") : /插件|脚本|扩展|extension|script|plugin|工具|助手/i;
  return chs
    .filter((c) => [0, 5, 15].includes(c.type))
    .filter((c) => re.test(c.name || ""))
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type === 15 ? "forum" : c.type === 5 ? "announcement" : "text",
      parentId: c.parent_id ?? null,
    }));
}
