/**
 * Discord REST 客户端。
 *
 * 要点：
 *  - 429 要按 retry_after 等待后重试，Discord 限速很密
 *  - 5xx 退避重试
 *  - 走 HTTPS_PROXY（本机默认 127.0.0.1:7890）
 *  - 401 直接抛出，由上层判断 token 失效
 *
 * 代理支持依赖 undici。它在 DSH 宿主环境里一定有，但独立运行时可能缺失，
 * 所以动态加载：拿不到就退回 Node 原生 fetch（不带代理，直连可用时仍能跑）。
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

const API = "https://discord.com/api/v9";

/** Discord 官方推荐伪装成浏览器 UA，否则部分端点会被 Cloudflare 拦。 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

let proxyAgent = null;
let proxyUsed = null;
/**
 * 代理临时旁路截止时间。
 *
 * 本机代理（FlClashCore 之类）会重启，重启期间所有请求失败、插件跟着全废。
 * 一旦识别出是代理连不上，就先直连 60 秒，之后自动再试代理。
 */
let proxyBypassUntil = 0;

/** 当前是否应当走直连（没有代理，或代理刚失败过）。 */
function proxyBypassed() {
  return Date.now() < proxyBypassUntil;
}

function agent() {
  if (proxyBypassed()) return null;
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (!proxy) return null;
  if (!undiciMod) return null; // 没有 undici 就直连
  const { ProxyAgent } = undiciMod;
  if (proxy !== proxyUsed) {
    proxyAgent = new ProxyAgent(proxy);
    proxyUsed = proxy;
  }
  return proxyAgent;
}

/**
 * 判断这个网络错误是不是「代理本身连不上」，而不是目标站点的问题。
 *
 * undici 的 ProxyAgent 在代理挂掉时会报 ECONNREFUSED 127.0.0.1:7890，
 * 或 `Proxy response (502) !== 200 when HTTP CONNECT`。
 */
function isProxyFailure(err) {
  const s = `${err?.code || ""} ${err?.message || ""}`.toLowerCase();
  return (
    s.includes("proxy") ||
    (s.includes("econnrefused") && /127\.0\.0\.1|localhost|::1/.test(s))
  );
}

/** 统一的 fetch 入口：有 undici 用 undici，否则用原生。 */
async function doFetch(url, init) {
  await loadUndici();
  const f = undiciMod ? undiciMod.fetch : globalThis.fetch;
  return f(url, init);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 全局并发闸门：Discord 对同一 token 的并发很敏感，串行更稳。 */
let chain = Promise.resolve();
function serialize(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

export class DiscordError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "DiscordError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * 发一个 GET 请求，自动处理限速与瞬时错误。
 *
 * @param {string} token
 * @param {string} route 形如 /channels/123/messages
 * @param {object} query
 */
export function apiGet(token, route, query = {}, { retries = 4 } = {}) {
  return serialize(async () => {
    const url = new URL(API + route);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const a = agent();
      let res;
      try {
        res = await doFetch(url, {
          method: "GET",
          headers: {
            Authorization: token,
            "User-Agent": UA,
            Accept: "application/json",
          },
          ...(a ? { dispatcher: a } : {}),
        });
      } catch (err) {
        // 代理连不上 → 立刻切直连重试，不走退避（代理重启是常态，退避只是白等）
        if (isProxyFailure(err) && !proxyBypassed()) {
          proxyBypassUntil = Date.now() + 60_000;
          if (attempt < retries) continue;
        }
        if (attempt >= retries) {
          throw new DiscordError(`network error: ${err.message}`, {
            status: 0,
          });
        }
        await sleep(500 * attempt);
        continue;
      }

      if (res.status === 429) {
        let wait = 1;
        try {
          const j = await res.json();
          wait = Number(j.retry_after ?? 1);
        } catch {
          /* 用默认值 */
        }
        if (attempt >= retries) {
          throw new DiscordError("rate limited", { status: 429 });
        }
        await sleep(Math.ceil(wait * 1000) + 150);
        continue;
      }

      if (res.status >= 500 && attempt < retries) {
        await sleep(400 * attempt);
        continue;
      }

      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }

      if (res.status === 401) {
        throw new DiscordError("token 无效或已失效", {
          status: 401,
          code: body?.code,
          body,
        });
      }
      if (!res.ok) {
        throw new DiscordError(
          `HTTP ${res.status}: ${typeof body === "string" ? body : body?.message || ""}`,
          { status: res.status, code: body?.code, body }
        );
      }
      return body;
    }
  });
}

/** 便捷包装：拿当前用户。 */
export const getMe = (token) => apiGet(token, "/users/@me");

/** 单个用户资料。 */
export const getUser = (token, userId) => apiGet(token, `/users/${userId}`);

/** 单条消息。 */
export const getMessage = (token, channelId, messageId) =>
  apiGet(token, `/channels/${channelId}/messages/${messageId}`);

/** 解析邀请码（不需要是成员；带人数统计与过期时间）。 */
export const getInvite = (token, code) =>
  apiGet(token, `/invites/${encodeURIComponent(code)}`, {
    with_counts: true,
    with_expiration: true,
  });

/**
 * 某条消息上某个表情的回应人列表。
 * emoji 形式：unicode 原样（🔥），自定义表情是 name:id。
 */
export const getReactionUsers = (token, channelId, messageId, emoji, limit = 25) =>
  apiGet(
    token,
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    { limit: Math.min(Number(limit) || 25, 100) }
  );

/** 当前账号所在的服务器。 */
export const getGuilds = (token) => apiGet(token, "/users/@me/guilds");

/** 服务器的频道列表（含分类）。 */
export const getGuildChannels = (token, guildId) =>
  apiGet(token, `/guilds/${guildId}/channels`);

/** 频道详情。 */
export const getChannel = (token, channelId) =>
  apiGet(token, `/channels/${channelId}`);

/**
 * 频道消息，按 before/after 翻页。
 * Discord 单页上限 100。
 */
export const getMessages = (token, channelId, { limit = 50, before, after } = {}) =>
  apiGet(token, `/channels/${channelId}/messages`, {
    limit: Math.min(Number(limit) || 50, 100),
    before,
    after,
  });

/** 服务器成员（需要 GUILD_MEMBERS 权限；没有会返回 403）。 */
export const getMembers = (token, guildId, { limit = 100, after } = {}) =>
  apiGet(token, `/guilds/${guildId}/members`, {
    limit: Math.min(Number(limit) || 100, 1000),
    after,
  });

/** 按名字搜成员（Discord 自带搜索，比拉全量再过滤省事）。 */
export const searchMembers = (token, guildId, query, limit = 20) =>
  apiGet(token, `/guilds/${guildId}/members/search`, { query, limit });

/** 私信频道列表。 */
export const getDmChannels = (token) => apiGet(token, "/users/@me/channels");

/** 置顶消息。 */
export const getPinned = (token, channelId) =>
  apiGet(token, `/channels/${channelId}/pins`);

/** 服务器信息。 */
export const getGuild = (token, guildId, withCounts = true) =>
  apiGet(token, `/guilds/${guildId}`, { with_counts: withCounts });

/** 服务器角色。 */
export const getRoles = (token, guildId) => apiGet(token, `/guilds/${guildId}/roles`);

/** 论坛/子区频道里的活跃帖子。 */
export const getActiveThreads = (token, guildId) =>
  apiGet(token, `/guilds/${guildId}/threads/active`);

/** 频道已归档的公开帖子。 */
export const getArchivedThreads = (token, channelId, { limit = 50, before } = {}) =>
  apiGet(token, `/channels/${channelId}/threads/archived/public`, { limit, before });
