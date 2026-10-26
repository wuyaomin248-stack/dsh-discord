/**
 * 从浏览器的 Local Storage leveldb 里取出 Discord token。
 *
 * 为什么这么做：Discord 网页版把 token 明文存在 localStorage，浏览器一登录
 * 就等于把凭证摆在磁盘上。直接读 leveldb 比让用户手抄 DevTools 可靠得多。
 *
 * 只读：先把 leveldb 目录复制到临时目录再解析。浏览器运行时原文件被锁住，
 * 且随时可能写入，直接读会拿到半截数据。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Discord token 的两种形态。 */
const TOKEN_RE =
  /(?:mfa\.[\w-]{20,90}|[\w-]{24,26}\.[\w-]{6}\.[\w-]{25,40})/g;

/** 各浏览器的 Local Storage 根目录（Windows / macOS / Linux）。 */
export function browserRoots(which = "auto") {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localappdata =
    process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");

  const defs = {
    edge: [
      path.join(localappdata, "Microsoft", "Edge", "User Data"),
      path.join(home, "Library", "Application Support", "Microsoft Edge"),
      path.join(home, ".config", "microsoft-edge"),
    ],
    chrome: [
      path.join(localappdata, "Google", "Chrome", "User Data"),
      path.join(home, "Library", "Application Support", "Google", "Chrome"),
      path.join(home, ".config", "google-chrome"),
    ],
    brave: [
      path.join(localappdata, "BraveSoftware", "Brave-Browser", "User Data"),
      path.join(home, "Library", "Application Support", "BraveSoftware",
                "Brave-Browser"),
    ],
  };

  if (which === "auto") return defs;
  const pick = defs[which];
  return pick ? { [which]: pick } : {};
}

/** 列出某个 User Data 下所有 profile 目录。 */
function profilesOf(userDataDir) {
  try {
    return fs
      .readdirSync(userDataDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^(Default|Profile \d+)$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** 把 leveldb 目录复制到临时目录，返回路径；调用方负责清理。 */
function snapshotLeveldb(leveldbDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-discord-ls-"));
  let copied = 0;
  try {
    for (const name of fs.readdirSync(leveldbDir)) {
      const src = path.join(leveldbDir, name);
      try {
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(tmp, name));
          copied += 1;
        }
      } catch {
        // 文件正被写入，跳过即可，其它文件里通常也有同样的记录
      }
    }
  } catch {
    // 目录读不了就返回空快照
  }
  return { dir: tmp, copied };
}

/**
 * 扫一个 profile 的 leveldb，返回命中的 token 候选。
 *
 * 只在内容里出现 discord 字样的文件上做匹配，避免把别的站点的
 * 类似字符串当成 token。
 */
function scanProfile(leveldbDir) {
  const { dir, copied } = snapshotLeveldb(leveldbDir);
  const hits = new Set();
  try {
    if (copied === 0) return { hits, copied };
    for (const name of fs.readdirSync(dir)) {
      let data;
      try {
        data = fs.readFileSync(path.join(dir, name));
      } catch {
        continue;
      }
      const lower = data.toString("latin1").toLowerCase();
      if (!lower.includes("discord")) continue;
      const text = data.toString("latin1");
      for (const m of text.match(TOKEN_RE) || []) hits.add(m);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { hits, copied };
}

/**
 * 从所有（或指定）浏览器抓 token。
 *
 * @returns {Promise<{found: Array<{browser,profile,token}>, scanned: Array}>}
 */
export async function harvestTokens({ which = "auto" } = {}) {
  const roots = browserRoots(which);
  const found = [];
  const scanned = [];

  for (const [browser, dirs] of Object.entries(roots)) {
    for (const userData of dirs) {
      if (!fs.existsSync(userData)) continue;
      for (const profile of profilesOf(userData)) {
        const leveldb = path.join(userData, profile, "Local Storage", "leveldb");
        if (!fs.existsSync(leveldb)) continue;
        const { hits, copied } = scanProfile(leveldb);
        scanned.push({ browser, profile, files: copied, candidates: hits.size });
        for (const token of hits) found.push({ browser, profile, token });
      }
    }
  }
  return { found, scanned };
}

/**
 * 读取手工配置的 token（环境变量优先）。
 * 这样在浏览器没登录、或想指定某个账号时也有路可走。
 */
export function tokenFromEnv(env = process.env) {
  const raw = env.DISCORD_TOKEN || env.DISCORD_TOKENS || "";
  return String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从 token 里读出账号 ID（第一段是 base64 编码的 user id）。 */
export function userIdFromToken(token) {
  try {
    const first = String(token).split(".")[0];
    const decoded = Buffer.from(first, "base64").toString("utf8");
    return /^\d{15,25}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** token 打码，用于日志和输出，避免整串泄露。 */
export function maskToken(token) {
  const s = String(token);
  if (s.length <= 14) return s.slice(0, 4) + "…";
  return s.slice(0, 8) + "…" + s.slice(-6);
}
