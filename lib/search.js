/**
 * 搜索：本地过滤 + Discord 服务端搜索。
 *
 * 服务端搜索（/guilds/{id}/messages/search）能按关键词、作者、时间、频道
 * 精确筛选，但需要该服务器开启搜索索引，且对无权限频道会静默跳过。
 * 本地过滤（拉消息再匹配）慢一些，但对任何频道都能用，还能做正则。
 *
 * 两者互补：优先服务端，拿不到再用本地。
 */
import { getMessages, getGuildChannels, apiGet } from "./api.js";

/** 把用户写的时间转成 Discord 要的 snowflake 边界。 */
export function snowflakeForDate(date) {
  const DISCORD_EPOCH = 1420070400000n;
  const ms = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(ms)) return null;
  return ((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n).toString();
}

/** snowflake 里带创建时间，用来给结果排序或显示。 */
export function dateFromSnowflake(id) {
  try {
    const DISCORD_EPOCH = 1420070400000n;
    return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
  } catch {
    return null;
  }
}

/**
 * 服务端搜索。
 *
 * @param {string} token
 * @param {string} guildId
 * @param {object} opts
 *   content   关键词
 *   authorId  作者 ID
 *   channelId 限定频道
 *   minId/maxId 时间边界（snowflake）
 *   has       附件类型：image/video/link/file/sound/embed
 *   sort      timestamp（默认）| relevance
 *   offset    分页偏移，25 条一页
 */
export async function searchGuild(token, guildId, opts = {}) {
  const {
    content,
    authorId,
    channelId,
    minId,
    maxId,
    has,
    sort = "timestamp",
    offset = 0,
    limit = 25,
  } = opts;

  const q = { sort, offset };
  if (content) q.content = content;
  if (authorId) q.author_id = authorId;
  if (channelId) q.channel_id = channelId;
  if (minId) q.min_id = minId;
  if (maxId) q.max_id = maxId;
  if (has) q.has = has;

  return apiGet(token, `/guilds/${guildId}/messages/search`, q);
}

/** 服务端搜索的一页通常是 25 条；这是它的总页数信息。 */
export function searchPageInfo(result) {
  return {
    total: result?.total_results ?? 0,
    messages: result?.messages ?? [],
    documentsIndexed: result?.documents_indexed ?? 0,
  };
}

/**
 * 拆开服务端搜索的二维结果。
 *
 * Discord 返回的 messages 是「每组一个上下文窗口」：内层数组里通常有多条，
 * 真正命中的那条带 hit: true，其余是上下文。只取扁平列表会丢掉这个区分，
 * 也会把上下文当成命中。
 *
 * 返回 [{ message, hit, context }]，context 是同一组里的其它消息。
 */
export function explicateSearchResults(result) {
  const groups = result?.messages || [];
  const out = [];
  for (const g of groups) {
    const inner = Array.isArray(g) ? g : [g];
    if (!inner.length) continue;
    // 找命中项：优先 hit: true；没有标记就取中间那条（Discord 的默认布局）
    let hitIdx = inner.findIndex((m) => m?.hit === true);
    if (hitIdx < 0) hitIdx = Math.floor(inner.length / 2);
    const hitMsg = inner[hitIdx];
    const context = inner
      .filter((_, i) => i !== hitIdx)
      .map((m) => ({ id: m.id, author: m.author?.username, content: m.content }));
    out.push({ message: hitMsg, hit: true, context });
  }
  return out;
}

/**
 * 本地过滤：翻频道历史，按关键词/正则/作者筛。
 *
 * @param {string} token
 * @param {string} channelId
 * @param {object} opts
 *   pattern   字符串或正则源
 *   regex     是否按正则解释
 *   authorId  只保留该作者
 *   limit     最多返回几条命中
 *   scan      最多翻多少条消息（控制耗时）
 */
export async function filterChannel(token, channelId, opts = {}) {
  const {
    pattern = "",
    regex = false,
    authorId,
    limit = 50,
    scan = 500,
    before,
    onForbidden = "throw", // throw | skip
  } = opts;

  let matcher = null;
  if (pattern) {
    if (regex) {
      try {
        matcher = new RegExp(pattern, "i");
      } catch (e) {
        throw new Error("正则无效: " + e.message);
      }
    } else {
      const needle = pattern.toLowerCase();
      matcher = { test: (s) => String(s).toLowerCase().includes(needle) };
    }
  }

  const hits = [];
  let cursor = before;
  let scanned = 0;

  while (scanned < scan && hits.length < limit) {
    let batch;
    try {
      batch = await getMessages(token, channelId, { limit: 100, before: cursor });
    } catch (e) {
      // 私密/无权限频道会让整轮搜索白跑，按调用方要求决定跳过还是抛出
      if (e?.status === 403 && onForbidden === "skip") {
        return { hits, scanned, forbidden: true };
      }
      throw e;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const m of batch) {
      scanned += 1;
      if (authorId && m.author?.id !== authorId) continue;
      if (matcher && !matcher.test(m.content || "")) continue;
      hits.push(m);
      if (hits.length >= limit) break;
    }
    cursor = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }

  return { hits, scanned };
}

/**
 * 跨频道扫：在一个服务器里按关键词找，按频道分组返回。
 * 适合「这个服务器里哪里提到过 X」这种问题。
 */
export async function filterGuild(token, guildId, opts = {}) {
  const { maxChannels = 10, scanPerChannel = 200, ...rest } = opts;

  const channels = await getGuildChannels(token, guildId);
  // 只扫能读文字的频道；语音/分类跳过
  const readable = channels.filter(
    (c) => [0, 5, 10, 11, 12, 15].includes(c.type) // 文本/公告/公告串/公开串/私密串/论坛
  );

  const results = [];
  for (const ch of readable.slice(0, maxChannels)) {
    try {
      const { hits, scanned, forbidden } = await filterChannel(token, ch.id, {
        ...rest,
        scan: scanPerChannel,
        onForbidden: "skip",
      });
      if (forbidden) {
        results.push({
          channelId: ch.id,
          channelName: ch.name,
          parentId: ch.parent_id ?? null,
          forbidden: true,
          scanned,
          hits: [],
        });
        continue;
      }
      if (hits.length) {
        results.push({
          channelId: ch.id,
          channelName: ch.name,
          parentId: ch.parent_id ?? null,
          scanned,
          hits,
        });
      }
    } catch (e) {
      // 其它错误也跳过，不中断整轮
      results.push({
        channelId: ch.id,
        channelName: ch.name,
        error: e.message,
        hits: [],
      });
    }
  }
  return results;
}
