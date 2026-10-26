/**
 * 附件下载与文件判型。
 *
 * 为什么需要：Discord CDN 的链接是签名 URL，大约 24 小时后失效
 * （URL 里 ex= 参数是到期时间戳）。要把信息留住，必须在有效期内落地。
 *
 * 另一个用途是判型：Discord 上大量 PNG 只是封面图，不是角色卡。
 * 导入酒馆前必须确认文件里真有 chara / ccv3 数据块。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 代理支持靠 undici。宿主环境一定有，独立运行时可能缺失，
 * 所以动态加载，拿不到就退回原生 fetch（直连）。
 */
let undiciMod;
let loadTried = false;

async function loadUndici() {
  if (!loadTried) {
    loadTried = true;
    try {
      undiciMod = await import("undici");
    } catch {
      undiciMod = null;
    }
  }
  return undiciMod;
}

let agent = null;
let agentOf = null;

function proxyAgent() {
  const p =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (!p || !undiciMod) return null;
  if (p !== agentOf) {
    const { ProxyAgent } = undiciMod;
    agent = new ProxyAgent(p);
    agentOf = p;
  }
  return agent;
}

async function doFetch(url) {
  await loadUndici();
  const f = undiciMod ? undiciMod.fetch : globalThis.fetch;
  const a = proxyAgent();
  return f(url, a ? { dispatcher: a } : {});
}

/** 从 URL 里读出签名到期时间（Discord CDN 的 ex 参数）。 */
export function urlExpiry(url) {
  try {
    const ex = new URL(url).searchParams.get("ex");
    if (!ex) return null;
    const sec = parseInt(ex, 16);
    if (!Number.isFinite(sec)) return null;
    return new Date(sec * 1000);
  } catch {
    return null;
  }
}

/** 文件名清洗：去掉路径分隔符和 Windows 非法字符。 */
export function safeName(name, fallback = "file") {
  const base = path.basename(String(name || fallback));
  return base.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120) || fallback;
}

/**
 * 从 PNG 的文本块里取角色卡数据。
 *
 * 关键：角色卡不是独立的 ccv3 chunk，而是塞在 tEXt/zTXt/iTXt 里，
 * 结构是 keyword + \0 + base64(JSON)，keyword 为 "chara" 或 "ccv3"。
 * 之前误以为 chunk type 就叫 ccv3，导致解不出名字。
 */
function readPngTextChunks(buf) {
  const out = [];
  if (buf.length < 8 || buf.toString("latin1", 1, 4) !== "PNG") return out;
  let off = 8;
  let guard = 0;
  while (off + 8 <= buf.length && guard < 5000) {
    guard += 1;
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const start = off + 8;
    if (type === "IEND") break;
    if (len < 0 || start + len > buf.length) break;
    if (type === "tEXt") {
      const data = buf.subarray(start, start + len);
      const sep = data.indexOf(0);
      if (sep > 0) {
        out.push({
          keyword: data.toString("latin1", 0, sep),
          text: data.toString("latin1", sep + 1),
        });
      }
    } else if (type === "zTXt" || type === "iTXt") {
      // 压缩或国际化文本块：关键字在开头，后面可能压过，名字常拿不到，
      // 但存在本身说明可能是卡，交给上层按字节判断。
      const data = buf.subarray(start, start + len);
      const sep = data.indexOf(0);
      if (sep > 0) {
        out.push({
          keyword: data.toString("latin1", 0, sep),
          text: "",
          compressed: type === "zTXt",
        });
      }
    }
    off += 12 + len;
  }
  return out;
}

/**
 * 判断一个已下载的文件是不是真正的角色卡。
 *
 * 返回 { ok, kind, name, spec, why, size }
 *   kind: chara | ccv3 | json | image
 */
export function inspectCard(buf, filename = "") {
  const lower = String(filename).toLowerCase();

  if (lower.endsWith(".json")) {
    let j;
    try {
      j = JSON.parse(buf.toString("utf8"));
    } catch {
      return { ok: false, kind: "unknown", why: "JSON 解析失败", size: buf.length };
    }
    // V2/V3 卡把字段包在 data 里
    const body = j.data && typeof j.data === "object" ? j.data : j;
    const fields = ["name", "description", "first_mes", "personality", "scenario"]
      .filter((k) => typeof body[k] === "string" && body[k].length > 0);
    if (fields.length >= 2 && body.name) {
      return {
        ok: true,
        kind: "json",
        name: body.name,
        spec: j.spec || (j.data ? "chara_card_v2+" : null),
        fieldCount: fields.length,
        firstMesLen: (body.first_mes || "").length,
        size: buf.length,
      };
    }
    return {
      ok: false,
      kind: "json",
      why: `JSON 但不像角色卡（有效字段 ${fields.join(",") || "无"}）`,
      size: buf.length,
    };
  }

  // 图片：先看 PNG 文本块
  const texts = readPngTextChunks(buf);
  const cardBlock = texts.find(
    (t) => t.keyword === "ccv3" || t.keyword === "chara"
  );

  if (!cardBlock) {
    // WebP 的情况：数据直接内联，退回裸搜关键字
    const asLatin = buf.toString("latin1");
    const inlineCcv3 = asLatin.includes("ccv3");
    const inlineChara = asLatin.includes("chara");
    if (!inlineCcv3 && !inlineChara) {
      return {
        ok: false,
        kind: "image",
        why: "图片里没有 chara/ccv3 数据（多半是封面图）",
        size: buf.length,
      };
    }
    return {
      ok: true,
      kind: inlineCcv3 ? "ccv3" : "chara",
      name: null,
      spec: null,
      size: buf.length,
    };
  }

  // 解出名字
  let name = null;
  let spec = null;
  let firstMesLen = null;
  if (cardBlock.text) {
    try {
      const raw = Buffer.from(cardBlock.text.trim(), "base64").toString("utf8");
      const j = JSON.parse(raw);
      const body = j.data && typeof j.data === "object" ? j.data : j;
      name = body.name || null;
      spec = j.spec || null;
      firstMesLen = (body.first_mes || "").length || null;
    } catch {
      /* 数据块在就算卡，名字解不出不影响判定 */
    }
  }

  return {
    ok: true,
    kind: cardBlock.keyword,
    name,
    spec,
    firstMesLen,
    ...(cardBlock.compressed ? { compressed: true } : {}),
    size: buf.length,
  };
}

/**
 * 下载一个 URL 到本地目录。
 *
 * @param {string} url
 * @param {object} opts
 *   dir      输出目录（必须存在或可创建）
 *   filename 覆盖文件名
 *   maxBytes 大小上限，默认 50MB
 *   inspect  是否做卡校验（默认 true）
 */
export async function downloadAttachment(url, opts = {}) {
  const {
    dir = process.cwd(),
    filename,
    maxBytes = 50 * 1024 * 1024,
    inspect = true,
  } = opts;

  const res = await doFetch(url);
  if (!res.ok) {
    throw new Error(`下载失败 HTTP ${res.status}`);
  }

  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > maxBytes) {
    throw new Error(
      `文件过大：${(len / 1024 / 1024).toFixed(1)}MB > 上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB`
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(`文件过大：${(buf.length / 1024 / 1024).toFixed(1)}MB`);
  }

  // 文件名：URL 末段优先
  let name = filename;
  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    } catch {
      name = "";
    }
  }
  name = safeName(name, "attachment");

  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, name);
  // 重名不覆盖，加序号
  if (fs.existsSync(target)) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let i = 2;
    while (fs.existsSync(path.join(dir, `${stem} (${i})${ext}`))) i += 1;
    target = path.join(dir, `${stem} (${i})${ext}`);
  }
  fs.writeFileSync(target, buf);

  const out = {
    path: target,
    bytes: buf.length,
    contentType: res.headers.get("content-type"),
    expiresAt: urlExpiry(url)?.toISOString() ?? null,
  };
  if (inspect) out.card = inspectCard(buf, name);
  return out;
}
