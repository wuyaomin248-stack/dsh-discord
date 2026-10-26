/**
 * dsh-discord — Discord 只读搜索与信息获取。
 *
 * 设计取向：用户主要拿它「搜索和获得信息」，所以工具围绕读展开，
 * 不提供发消息、删消息这类写操作。凭证优先从浏览器 leveldb 自动抓，
 * 抓不到再退回环境变量 DISCORD_TOKEN。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  harvestTokens,
  tokenFromEnv,
  maskToken,
  userIdFromToken,
} from "./token.js";
import {
  getMe,
  getGuilds,
  getGuild,
  getGuildChannels,
  getChannel,
  getMessages,
  getMembers,
  searchMembers,
  getDmChannels,
  getPinned,
  getRoles,
  getActiveThreads,
  getArchivedThreads,
  apiGet,
} from "./api.js";
import {
  searchGuild,
  filterChannel,
  filterGuild,
  snowflakeForDate,
  explicateSearchResults,
} from "./search.js";
import {
  compactMessage,
  compactChannel,
  compactGuild,
  compactMember,
  compactUser,
  groupByChannel,
  toMarkdown,
} from "./format.js";
import { downloadAttachment, urlExpiry, inspectCard } from "./download.js";
import {
  collectEntries,
  resolveEntry,
  verifyFiles,
  pickRandom,
  cardCandidates,
} from "./cards.js";
import {
  listForumThreads,
  resolvePluginThread,
  verifyPluginFiles,
  pluginChannels,
  inspectPlugin,
} from "./plugins.js";

export const name = "dsh-discord";
export const inject = ["tools"];

export const Config = z.object({
  /** 默认浏览器：auto 扫全部，也可指定 edge / chrome / brave。 */
  browser: z.string().default("auto"),
  /** 抓到的 token 打码后写日志，默认关闭以免泄露。 */
  logTokens: z.boolean().default(false),
});

/** 进程内 token 缓存，避免每次调用都重扫磁盘。 */
let cache = null;
/** 服务器频道名缓存：id -> name，搜索补名字时用，避免每次拉全量频道。 */
const channelNames = new Map();

/**
 * 取可用 token 列表。
 *
 * 顺序：环境变量 > 浏览器抓取。环境变量优先，方便临时指定账号。
 */
async function tokens(cfg) {
  const fromEnv = tokenFromEnv();
  if (fromEnv.length) {
    return fromEnv.map((t) => ({ token: t, source: "env", profile: null }));
  }
  if (cache && cache.length) return cache;
  const { found } = await harvestTokens({ which: cfg?.browser || "auto" });
  // 同一 token 可能在多个文件里重复出现，按值去重
  const seen = new Set();
  cache = found
    .filter((f) => {
      if (seen.has(f.token)) return false;
      seen.add(f.token);
      return true;
    })
    .map((f) => ({ ...f, source: f.browser }));
  return cache;
}

/**
 * 取第一个有效 token，并返回它对应的账号。
 *
 * token 会因为换 IP、改密码、在别处登出而失效。全都没通过且原因里有 401 时，
 * 丢掉缓存重新抓一次——浏览器里通常已经有新的了。
 */
async function primary(cfg, { retried = false } = {}) {
  const list = await tokens(cfg);
  if (!list.length) {
    throw new Error(
      "没找到 Discord token：先在 Edge/Chrome 里登录 discord.com，" +
        "或设置环境变量 DISCORD_TOKEN"
    );
  }
  let lastErr = null;
  let saw401 = false;
  for (const cand of list) {
    try {
      const me = await getMe(cand.token);
      return { token: cand.token, me, source: cand.source, profile: cand.profile };
    } catch (e) {
      if (e?.status === 401) saw401 = true;
      lastErr = e;
    }
  }
  // 缓存的 token 全失效 → 清掉重抓一次（浏览器可能已经刷新过）
  if (saw401 && !retried && !tokenFromEnv().length) {
    cache = null;
    channelNames.clear();
    return primary(cfg, { retried: true });
  }
  throw new Error(
    `找到 ${list.length} 个 token 但都无效：${lastErr?.message || "未知原因"}`
  );
}

/** 取服务器的 id→频道名映射（按服务器缓存）。 */
async function channelNameMap(token, guildId) {
  if (channelNames.has(guildId)) return channelNames.get(guildId);
  try {
    const ch = await getGuildChannels(token, guildId);
    const map = new Map(ch.map((c) => [c.id, c.name]));
    channelNames.set(guildId, map);
    return map;
  } catch {
    return new Map();
  }
}

/**
 * 给一批消息补频道名。
 *
 * 关键：帖子（type 11/12）不在 guilds/{id}/channels 列表里，只查那张表会漏。
 * 漏掉的就逐个 GET /channels/{id} 捞名字，并写回缓存，下次不再查。
 */
async function attachChannelNames(token, guildId, messages) {
  // 没有 guildId 时跳过频道列表（比如按 around 读上下文），直接逐个查
  const names = guildId ? await channelNameMap(token, guildId) : new Map();
  const missing = new Set();
  for (const m of messages) {
    const cid = m.channel_id ?? m.channelId;
    if (cid && !names.has(cid)) missing.add(cid);
  }
  // 并发上限 5，避免一下子打爆限速
  const queue = [...missing];
  while (queue.length) {
    const batch = queue.splice(0, 5);
    await Promise.all(
      batch.map(async (cid) => {
        try {
          const ch = await getChannel(token, cid);
          if (ch?.name) names.set(cid, ch.name);
        } catch {
          // 查不到就留空，不阻断
        }
      })
    );
  }
  return names;
}

/** 结果信封：统一带上账号上下文，便于判断数据来源。 */
function envelope(ctx, payload) {
  return {
    account: compactUser(ctx.me),
    source: ctx.source,
    ...payload,
  };
}

/** 解析频道参数：接受 ID 或 #name，也接受纯 name（在当前服务器里找）。 */
async function resolveChannel(token, ref, guildId) {
  const s = String(ref || "").trim();
  if (/^\d{15,25}$/.test(s)) return { id: s, name: null };
  const name = s.replace(/^#/, "");
  if (!guildId) {
    throw new Error("用频道名查找时需要同时给出 guildId");
  }
  const channels = await getGuildChannels(token, guildId);
  const hit =
    channels.find((c) => c.name === name) ||
    channels.find((c) => c.name?.toLowerCase() === name.toLowerCase());
  if (!hit) throw new Error(`在服务器 ${guildId} 里没找到频道 ${name}`);
  return { id: hit.id, name: hit.name };
}

export function apply(ctx, config = {}) {
  const cfg = { browser: "auto", logTokens: false, ...config };

  /* ---------------- 凭证与账号 ---------------- */

  ctx.tools.register(
    defineTool({
      name: "discord_accounts",
      description:
        "列出本机浏览器里能抓到的 Discord 账号（自动从 Edge/Chrome 的 leveldb 取 token 并逐个验证）。返回每个账号的用户名、ID、邮箱、以及 token 打码。用于确认当前能用哪个账号。",
      parameters: {
        browser: {
          type: "string",
          description: "只扫某个浏览器：auto（默认）/ edge / chrome / brave",
        },
        verify: {
          type: "boolean",
          description: "是否逐个调 API 验证 token 有效（默认 true）",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            accounts: { type: "array", items: { type: "object", additionalProperties: false } },
            scanned: { type: "array", items: { type: "object", additionalProperties: false } },
            note: { type: "string" },
          },
        },
      },
      async execute({ browser = "auto", verify = true }) {
        const { found, scanned } = await harvestTokens({ which: browser });
        const seen = new Set();
        const uniq = found.filter((f) => {
          if (seen.has(f.token)) return false;
          seen.add(f.token);
          return true;
        });

        const accounts = [];
        for (const f of uniq) {
          const base = {
            tokenMasked: maskToken(f.token),
            tokenUserId: userIdFromToken(f.token),
            browser: f.browser,
            profile: f.profile,
          };
          if (!verify) {
            accounts.push({ ...base, valid: null });
            continue;
          }
          try {
            const me = await getMe(f.token);
            accounts.push({ ...base, valid: true, user: compactUser(me) });
          } catch (e) {
            accounts.push({ ...base, valid: false, error: e.message });
          }
        }

        if (cfg.logTokens) {
          for (const a of accounts) ctx.logger?.info?.(`discord token ${a.tokenMasked}`);
        }

        return {
          accounts,
          scanned,
          note: uniq.length
            ? "token 从浏览器 Local Storage 读出；env DISCORD_TOKEN 若设置会优先使用"
            : "没抓到 token：先在浏览器登录 discord.com，或设置 DISCORD_TOKEN",
        };
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "discord_servers",
      description:
        "列出当前账号所在的 Discord 服务器（含 ID、成员数、是否拥有者）。拿到 ID 后可用于后续的频道和搜索工具。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            account: { type: "object", additionalProperties: false },
            servers: { type: "array", items: { type: "object", additionalProperties: false } },
          },
        },
      },
      async execute() {
        const c = await primary(cfg);
        const guilds = await getGuilds(c.token);
        return envelope(c, { servers: guilds.map(compactGuild) });
      },
    })
  );

  /* ---------------- 频道与结构 ---------------- */

  ctx.tools.register(
    defineTool({
      name: "discord_channels",
      description:
        "列出某个服务器下的所有频道（文本/公告/语音/论坛/分类），带 ID、类型、话题、所属分类。用于摸清一个服务器的结构，或找到要读的频道 ID。",
      parameters: {
        guildId: { type: "string", description: "服务器 ID（discord_servers 返回）" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            account: { type: "object", additionalProperties: false },
            guild: { type: "object", additionalProperties: false },
            channels: { type: "array", items: { type: "object", additionalProperties: false } },
          },
        },
      },
      async execute({ guildId }) {
        const c = await primary(cfg);
        const [g, ch] = await Promise.all([
          getGuild(c.token, guildId),
          getGuildChannels(c.token, guildId),
        ]);
        const list = ch
          .map(compactChannel)
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        return envelope(c, { guild: compactGuild(g), channels: list });
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "discord_channel_info",
      description: "查单个频道的详情：名称、类型、话题、是否 NSFW、所属服务器。",
      parameters: {
        channelId: { type: "string", description: "频道 ID" },
      },
      output: { schema: { type: "object",
          additionalProperties: false, properties: {} } },
      async execute({ channelId }) {
        const c = await primary(cfg);
        const ch = await getChannel(c.token, channelId);
        return envelope(c, { channel: compactChannel(ch) });
      },
    })
  );

  /* ---------------- 读消息 ---------------- */

  ctx.tools.register(
    defineTool({
      name: "discord_messages",
      description:
        "读一个频道的消息。默认最近 50 条，可用 before/after 翻页。返回作者、时间、正文、附件、表情回应。用于浏览聊天记录或定位上下文。",
      parameters: {
        channel: {
          type: "string",
          description: "频道 ID，或 #频道名（用名字时需同时给 guildId）",
        },
        guildId: { type: "string", description: "服务器 ID，仅在用频道名时需要" },
        limit: { type: "number", description: "条数，1-100，默认 50" },
        before: { type: "string", description: "取这个消息 ID 之前的（翻旧账）" },
        after: { type: "string", description: "取这个消息 ID 之后的（追新）" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            account: { type: "object", additionalProperties: false },
            channel: { type: "object", additionalProperties: false },
            messages: { type: "array", items: { type: "object", additionalProperties: false } },
          },
        },
      },
      async execute({ channel, guildId, limit = 50, before, after }) {
        const c = await primary(cfg);
        const target = await resolveChannel(c.token, channel, guildId);
        const raw = await getMessages(c.token, target.id, { limit, before, after });
        const msgs = (raw || []).map((m) =>
          compactMessage(m, { channelName: target.name })
        );
        return envelope(c, {
          channel: { id: target.id, name: target.name },
          count: msgs.length,
          messages: msgs,
        });
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "discord_pins",
      description:
        "列出一个频道里被置顶的消息。置顶通常是规则、公告或重要资料，信息密度高。",
      parameters: {
        channel: { type: "string", description: "频道 ID 或 #频道名" },
        guildId: { type: "string", description: "用频道名时必填" },
      },
      output: { schema: { type: "object",
          additionalProperties: false, properties: {} } },
      async execute({ channel, guildId }) {
        const c = await primary(cfg);
        const target = await resolveChannel(c.token, channel, guildId);
        const pins = await getPinned(c.token, target.id);
        return envelope(c, {
          channel: { id: target.id, name: target.name },
          pins: (pins || []).map((p) => compactMessage(p.message || p)),
        });
      },
    })
  );

  /* ---------------- 搜索（核心） ---------------- */

  ctx.tools.register(
    defineTool({
      name: "discord_search",
      description:
        "在一个服务器里搜索消息。走 Discord 服务端搜索索引，支持关键词、作者、频道、时间范围、附件类型筛选，可按时间或相关度排序。这是找「哪里提到过 X」最快的方式。返回匹配消息与总命中数。",
      parameters: {
        guildId: { type: "string", description: "服务器 ID" },
        query: { type: "string", description: "关键词，留空则只按其它条件筛" },
        authorId: { type: "string", description: "只看某个作者的消息（用户 ID）" },
        channelId: { type: "string", description: "限定某个频道" },
        since: {
          type: "string",
          description: "起始时间，ISO 日期或 YYYY-MM-DD",
        },
        until: { type: "string", description: "结束时间，ISO 日期或 YYYY-MM-DD" },
        has: {
          type: "string",
          description: "附件类型过滤：image / video / link / file / sound / embed",
        },
        sort: {
          type: "string",
          description: "排序：timestamp（默认，按时间倒序）/ relevance",
        },
        offset: { type: "number", description: "分页偏移，每页 25 条，默认 0" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            account: { type: "object", additionalProperties: false },
            total: { type: "number" },
            messages: { type: "array", items: { type: "object", additionalProperties: false } },
            byChannel: { type: "array", items: { type: "object", additionalProperties: false } },
          },
        },
      },
      async execute({
        guildId,
        query,
        authorId,
        channelId,
        since,
        until,
        has,
        sort = "timestamp",
        offset = 0,
      }) {
        const c = await primary(cfg);
        const minId = since ? snowflakeForDate(new Date(since)) : null;
        const maxId = until ? snowflakeForDate(new Date(until)) : null;

        const res = await searchGuild(c.token, guildId, {
          content: query,
          authorId,
          channelId,
          minId,
          maxId,
          has,
          sort,
          offset,
        });

        // Discord 返回的是「每组一个上下文窗口」的二维数组，命中项带 hit 标记。
        // 只 flatten 会把上下文当命中，也丢掉了命中与上下文的关系。
        const groups = explicateSearchResults(res);
        // 帖子（type 11/12）不在频道列表里，必须逐个补名字，否则全是无名 ID
        const names = await attachChannelNames(
          c.token,
          guildId,
          groups.map((g) => g.message)
        );
        const msgs = groups.map(({ message, context }) =>
          Object.assign(
            compactMessage(message, { channelName: names.get(message.channel_id) }),
            context.length ? { context: context.slice(0, 2) } : {}
          )
        );

        return envelope(c, {
          total: res.total_results ?? msgs.length,
          offset,
          hasMore: (res.total_results ?? 0) > offset + 25,
          messages: msgs,
          byChannel: groupByChannel(msgs),
        });
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "discord_filter",
      description:
        "本地过滤频道历史：翻消息再按关键词或正则匹配。适合服务端搜索索引没覆盖的频道，或需要正则/大小写精确控制的场景。可限定作者、扫描深度。",
      parameters: {
        channel: { type: "string", description: "频道 ID 或 #频道名" },
        guildId: { type: "string", description: "用频道名时必填" },
        pattern: { type: "string", description: "关键词或正则" },
        regex: { type: "boolean", description: "把 pattern 当正则解释（默认 false）" },
        authorId: { type: "string", description: "只看某个作者" },
        limit: { type: "number", description: "最多返回几条命中，默认 50" },
        scan: {
          type: "number",
          description: "最多翻多少条历史消息，默认 500。越大越慢但越全",
        },
      },
      output: { schema: { type: "object",
          additionalProperties: false, properties: {} } },
      async execute({ channel, guildId, pattern, regex, authorId, limit = 50, scan = 500 }) {
        const c = await primary(cfg);
        const target = await resolveChannel(c.token, channel, guildId);
        const { hits, scanned, forbidden } = await filterChannel(c.token, target.id, {
          pattern,
          regex,
          authorId,
          limit,
          scan,
        });
        return envelope(c, {
          channel: { id: target.id, name: target.name },
          scanned,
          ...(forbidden ? { forbidden: true } : {}),
          hits: hits.length,
          messages: hits.map((m) => compactMessage(m, { channelName: target.name })),
        });
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "discord_search_guild",
      description:
        "在一个服务器的多个频道里扫同一个关键词，按频道分组返回。适合「这个服务器里哪些地方提到过 X」，能一次覆盖多个频道。比逐个频道调用省事。",
      parameters: {
        guildId: { type: "string", description: "服务器 ID" },
        pattern: { type: "string", description: "关键词或正则" },
        regex: { type: "boolean", description: "按正则解释（默认 false）" },
        maxChannels: {
          type: "number",
          description: "最多扫多少个频道，默认 10",
        },
        scanPerChannel: {
          type: "number",
          description: "每个频道翻多少条历史，默认 200",
        },
        limit: { type: "number", description: "每个频道最多返回几条命中，默认 20" },
      },
      output: { schema: { type: "object",
          additionalProperties: false, properties: {} } },
      async execute({
        guildId,
        pattern,
        regex,
        maxChannels = 10,
        scanPerChannel = 200,
        limit = 20,
      }) {
        const c = await primary(cfg);
        const groups = await filterGuild(c.token, guildId, {
          pattern,
          regex,
          maxChannels,
          scanPerChannel,
          limit,
        });
        const totalHits = groups.reduce((n, g) => n + g.hits.length, 0);
        const skipped = groups.filter((g) => g.forbidden).map((g) => g.channelName);
        return envelope(c, {
          channelsScanned: groups.length,
          totalHits,
          ...(skipped.length ? { forbiddenChannels: skipped } : {}),
          groups: groups
            .filter((g) => g.hits.length || g.error)
            .map((g) => ({
              channel: g.channelName,
              channelId: g.channelId,
              hits: g.hits.length,
              ...(g.error ? { error: g.error } : {}),
              messages: g.hits.map((m) =>
                compactMessage(m, { channelName: g.channelName })
              ),
            })),
        });
      },
    })
  );

  /* ---------------- 成员 ---------------- */

  ctx.tools.register(
    defineTool({
      name: "discord_members",
      description:
        "找服务器里的成员。普通 token 没有 GUILD_MEMBERS 权限，直接列成员会 403，所以按这个顺序退：先按名字搜（有权限时最快），搜不到就从最近消息的作者里收集（能拿到实际活跃的人），最后退回服务器总人数。返回用户名、ID、昵称等，用于按作者筛消息。",
      parameters: {
        guildId: { type: "string", description: "服务器 ID" },
        query: {
          type: "string",
          description: "按名字搜索；留空则收集活跃成员",
        },
        limit: { type: "number", description: "条数，默认 100（搜索默认 20）" },
        after: { type: "string", description: "翻页游标（成员列表模式）" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            account: { type: "object", additionalProperties: true },
            count: { type: "number" },
            members: { type: "array", items: { type: "object", additionalProperties: true } },
            mode: { type: "string" },
            guildStats: { type: "object", additionalProperties: true },
            note: { type: "string" },
          },
        },
      },
      async execute({ guildId, query, limit, after }) {
        const c = await primary(cfg);
        const n = limit || (query ? 20 : 100);

        // 1. 有权限时优先走原生成员接口
        try {
          const list = query
            ? await searchMembers(c.token, guildId, query, n)
            : await getMembers(c.token, guildId, { limit: n, after });
          return envelope(c, {
            mode: query ? "search" : "list",
            count: (list || []).length,
            members: (list || []).map(compactMember),
          });
        } catch (e) {
          // 403 = 没有 GUILD_MEMBERS 权限，往下走降级路径
          if (e?.status !== 403) throw e;
        }

        // 2. 从消息作者里收集（真实可用的替代）
        const seen = new Map();
        try {
          const res = await searchGuild(c.token, guildId, {
            content: query || "",
            offset: 0,
          });
          for (const g of res.messages || []) {
            for (const m of Array.isArray(g) ? g : [g]) {
              const u = m.author;
              if (!u?.id || seen.has(u.id)) continue;
              seen.set(u.id, {
                id: u.id,
                username: u.username,
                ...(u.global_name ? { displayName: u.global_name } : {}),
                ...(u.bot ? { bot: true } : {}),
                source: "message-author",
              });
              if (seen.size >= n) break;
            }
            if (seen.size >= n) break;
          }
        } catch {
          /* 搜索也不可用就只给统计 */
        }

        // 3. 服务器规模（这个接口总是可用）
        let guildStats = null;
        try {
          const g = await getGuild(c.token, guildId);
          guildStats = {
            name: g.name,
            members: g.approximate_member_count ?? null,
            online: g.approximate_presence_count ?? null,
          };
        } catch {
          /* 拿不到就算了 */
        }

        return envelope(c, {
          mode: "authors",
          count: seen.size,
          members: [...seen.values()],
          ...(guildStats ? { guildStats } : {}),
          note:
            "普通 token 无 GUILD_MEMBERS 权限（members 与 members/search 都 403）。" +
            "这里改为从最近消息作者里收集，只能拿到发过言的人；要完整名单需要 bot token。",
        });
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "discord_roles",
      description: "列出服务器角色：名称、颜色、权限位、是否 hoist。用于理解一个服务器的组织结构。",
      parameters: {
        guildId: { type: "string", description: "服务器 ID" },
      },
      output: { schema: { type: "object",
          additionalProperties: false, properties: {} } },
      async execute({ guildId }) {
        const c = await primary(cfg);
        const roles = await getRoles(c.token, guildId);
        return envelope(c, {
          roles: (roles || []).map((r) => ({
            id: r.id,
            name: r.name,
            color: r.color,
            position: r.position,
            hoist: r.hoist,
            managed: r.managed,
            ...(r.permissions ? { permissions: r.permissions } : {}),
          })),
        });
      },
    })
  );

  /* ---------------- 私信与帖子 ---------------- */

  ctx.tools.register(
    defineTool({
      name: "discord_dms",
      description: "列出当前账号的私信频道（含群聊），带对方用户和最后一条消息时间。",
      parameters: {},
      output: { schema: { type: "object",
          additionalProperties: false, properties: {} } },
      async execute() {
        const c = await primary(cfg);
        const dms = await getDmChannels(c.token);
        return envelope(c, {
          channels: (dms || []).map((d) => ({
            id: d.id,
            type: d.type === 1 ? "dm" : "group-dm",
            recipients: (d.recipients || []).map((u) => ({
              id: u.id,
              username: u.username,
              displayName: u.global_name || null,
            })),
            lastMessageId: d.last_message_id || null,
          })),
        });
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "discord_threads",
      description:
        "列出论坛频道里的帖子。给 channelId 就列该频道（最准）；只给 guildId 时会自动找出服务器里所有论坛频道，各拉一批帖子汇总。注意：Discord 的「活跃帖子」端点 guilds/{id}/threads/active 只有 bot 能用，所以这里一律走 channels/{forum}/threads/archived/public（含活跃帖，archived 标记可区分）。",
      parameters: {
        guildId: {
          type: "string",
          description: "服务器 ID：自动扫该服务器所有论坛频道",
        },
        channelId: {
          type: "string",
          description: "论坛频道 ID：只列这一个（优先于 guildId）",
        },
        limit: { type: "number", description: "每个频道取多少条，默认 50" },
        maxForums: {
          type: "number",
          description: "只给 guildId 时最多扫几个论坛频道，默认 8",
        },
        onlyActive: {
          type: "boolean",
          description:
            "只保留未归档（活跃）的帖子。注意：普通 token 只能通过归档接口取帖，返回的多为 archived=true，这个开关常会得到 0 条",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            account: { type: "object", additionalProperties: true },
            mode: { type: "string" },
            threads: { type: "array", items: { type: "object", additionalProperties: true } },
            forumsScanned: { type: "array", items: { type: "object", additionalProperties: true } },
            note: { type: "string" },
          },
        },
      },
      async execute({ guildId, channelId, limit = 50, maxForums = 8, onlyActive = false }) {
        const c = await primary(cfg);

        /** 把一个频道的帖子列表规范化。 */
        const norm = (t, forum) => ({
          id: t.id,
          name: t.name,
          parentId: t.parent_id ?? forum?.id ?? null,
          ...(forum?.name ? { forumName: forum.name } : {}),
          messageCount: t.message_count ?? null,
          archived: t.thread_metadata?.archived ?? false,
          ...(t.thread_metadata?.create_timestamp
            ? { createdAt: t.thread_metadata.create_timestamp }
            : {}),
          ...(t.thread_metadata?.archive_timestamp
            ? { archivedAt: t.thread_metadata.archive_timestamp }
            : {}),
          url: `https://discord.com/channels/${forum?.guild_id || guildId || ""}/${t.id}`,
        });

        // 单频道模式
        if (channelId) {
          const res = await getArchivedThreads(c.token, channelId, { limit });
          let list = (res.threads || []).map((t) => norm(t, { id: channelId }));
          if (onlyActive) list = list.filter((t) => !t.archived);
          return envelope(c, {
            mode: "channel",
            threads: list,
            note: res.has_more
              ? "还有更多（has_more=true），用更小的 limit 或换频道继续"
              : null,
          });
        }

        if (!guildId) {
          throw new Error("给 guildId（扫全服论坛）或 channelId（单个论坛）");
        }

        // 全服模式：找出所有论坛频道，逐个拉
        const chs = await getGuildChannels(c.token, guildId);
        const forums = chs.filter((x) => x.type === 15).slice(0, maxForums);
        const threads = [];
        const forumsScanned = [];

        for (const f of forums) {
          try {
            const res = await getArchivedThreads(c.token, f.id, { limit });
            const got = (res.threads || []).map((t) => norm(t, f));
            const kept = onlyActive ? got.filter((t) => !t.archived) : got;
            threads.push(...kept);
            forumsScanned.push({
              id: f.id,
              name: f.name,
              count: kept.length,
              hasMore: res.has_more ?? false,
            });
          } catch (e) {
            // 私密论坛会 403，跳过不中断
            forumsScanned.push({
              id: f.id,
              name: f.name,
              count: 0,
              error: e?.status === 403 ? "无权限" : e.message.slice(0, 60),
            });
          }
        }

        // 按最后活动排序（有 messageCount 的优先，其次创建时间）
        threads.sort((a, b) => {
          const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
          const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
          return tb - ta;
        });

        const activeCount = threads.filter((t) => !t.archived).length;
        const hint =
          onlyActive && threads.length === 0
            ? "onlyActive 过滤后为空：普通 token 只能从归档接口取帖，几乎全是 archived=true。" +
              "要看活跃帖只能靠推送消息里的传送门，或用 bot token。"
            : `扫了 ${forums.length} 个论坛频道（服务器共 ${chs.filter((x) => x.type === 15).length} 个）。` +
              "活跃帖子端点需 bot 权限，这里用归档接口代替；archived=false 的才是活跃帖。";

        return envelope(c, {
          mode: "guild",
          threads,
          forumsScanned,
          activeCount,
          note: hint,
        });
      },
    })
  );

  /* ---------------- 落地 ---------------- */

  ctx.tools.register(
    defineTool({
      name: "discord_export",
      description:
        "把一次搜索结果落成 Markdown 文件，方便继续阅读、贴给别人或存档。搜完直接调用，不用二次翻取。返回文件路径与大小。",
      parameters: {
        guildId: { type: "string", description: "服务器 ID" },
        query: { type: "string", description: "搜索关键词，与 discord_search 一致" },
        authorId: { type: "string", description: "只导出某作者" },
        channelId: { type: "string", description: "限定某频道" },
        since: { type: "string", description: "起始时间" },
        until: { type: "string", description: "结束时间" },
        has: { type: "string", description: "附件类型过滤" },
        pages: {
          type: "number",
          description: "翻几页（每页 25 条），默认 1，最多 8",
        },
        title: { type: "string", description: "文档标题，默认自动生成" },
        outDir: {
          type: "string",
          description: "输出目录，默认当前工作目录",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            bytes: { type: "number" },
            count: { type: "number" },
            total: { type: "number" },
          },
        },
      },
      async execute({
        guildId,
        query,
        authorId,
        channelId,
        since,
        until,
        has,
        pages = 1,
        title,
        outDir,
      }) {
        const c = await primary(cfg);
        const minId = since ? snowflakeForDate(new Date(since)) : null;
        const maxId = until ? snowflakeForDate(new Date(until)) : null;

        const all = [];
        let total = 0;
        const pageCount = Math.min(Math.max(Number(pages) || 1, 1), 8);
        for (let p = 0; p < pageCount; p += 1) {
          const res = await searchGuild(c.token, guildId, {
            content: query,
            authorId,
            channelId,
            minId,
            maxId,
            has,
            offset: p * 25,
          });
          total = res.total_results ?? total;
          const pageGroups = explicateSearchResults(res);
          const names = await attachChannelNames(
            c.token,
            guildId,
            pageGroups.map((g) => g.message)
          );
          const batch = pageGroups.map(({ message }) =>
            compactMessage(message, { channelName: names.get(message.channel_id) })
          );
          all.push(...batch);
          // 没更多了就提前停，别空翻
          if (batch.length < 25) break;
        }

        const heading =
          title ||
          `Discord 搜索${query ? `「${query}」` : ""}${since ? ` 自 ${since}` : ""}`;
        const md = toMarkdown(all, { title: heading });

        const dir = outDir ? path.resolve(outDir) : process.cwd();
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const safe = String(heading).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
        const file = path.join(dir, `discord-${safe}-${stamp}.md`);
        fs.writeFileSync(file, md, "utf8");

        return {
          path: file,
          bytes: Buffer.byteLength(md, "utf8"),
          count: all.length,
          total,
        };
      },
    })
  );

  /* ---------------- 落地与上下文 ---------------- */

  ctx.tools.register(
    defineTool({
      name: "discord_archive",
      description:
        "把一个频道的完整历史消息翻出来存成 Markdown。跟 discord_export 的区别：export 走搜索（要有命中），archive 走翻页（把整个频道拉下来）。适合「把某个帖子的全部讨论存下来」。会自动限流翻页，可指定时间范围或条数上限。",
      parameters: {
        channel: {
          type: "string",
          description: "频道/帖子 ID，或 #频道名（用名字时给 guildId）",
        },
        guildId: { type: "string", description: "用频道名时必填" },
        maxMessages: {
          type: "number",
          description: "最多拉多少条，默认 1000。Discord 每页 100，太大很慢",
        },
        since: {
          type: "string",
          description: "只拉到这个时间之后的，ISO 或 YYYY-MM-DD",
        },
        until: {
          type: "string",
          description: "只拉到这个时间之前的",
        },
        outDir: { type: "string", description: "输出目录，默认当前工作目录" },
        title: { type: "string", description: "文档标题，默认自动生成" },
        noFile: {
          type: "boolean",
          description: "只在内存里返回不写文件（默认会写）",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            account: { type: "object", additionalProperties: true },
            channel: { type: "object", additionalProperties: true },
            count: { type: "number" },
            pages: { type: "number" },
            truncated: { type: "boolean" },
            path: { type: "string" },
            bytes: { type: "number" },
            firstMessageAt: { type: "string" },
            lastMessageAt: { type: "string" },
            messages: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
      },
      async execute({
        channel,
        guildId,
        maxMessages = 1000,
        since,
        until,
        outDir,
        title,
        noFile = false,
      }) {
        const c = await primary(cfg);
        const target = await resolveChannel(c.token, channel, guildId);

        const sinceMs = since ? new Date(since).getTime() : null;
        const untilMs = until ? new Date(until).getTime() : null;

        const collected = [];
        let cursor;
        let pages = 0;
        let truncated = false;
        let hitLowerBound = false;
        const cap = Math.max(1, Number(maxMessages) || 1000);

        // 从最新往前翻：撞到时间下界、条数上限、或没有更多就停
        while (!hitLowerBound && collected.length < cap) {
          pages += 1;
          const batch = await getMessages(c.token, target.id, {
            limit: 100,
            ...(cursor ? { before: cursor } : {}),
          });
          if (!Array.isArray(batch) || batch.length === 0) break;

          for (const m of batch) {
            const ms = Date.parse(m.timestamp);
            // 上界之前的消息跳过（不影响继续往前翻）
            if (untilMs && Number.isFinite(ms) && ms > untilMs) continue;
            // 下界：翻到这里就可以收手了
            if (sinceMs && Number.isFinite(ms) && ms < sinceMs) {
              hitLowerBound = true;
              break;
            }
            collected.push(m);
            if (collected.length >= cap) {
              truncated = true;
              break;
            }
          }
          if (hitLowerBound || collected.length >= cap) break;
          if (batch.length < 100) break;
          cursor = batch[batch.length - 1].id;
        }

        // 时间正序（翻页拿到的是倒序）
        collected.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

        const msgs = collected.map((m) =>
          compactMessage(m, { channelName: target.name })
        );

        const first = msgs[0]?.time ?? null;
        const last = msgs[msgs.length - 1]?.time ?? null;
        const heading =
          title || `${target.name || target.id} 频道归档${since ? ` 自 ${since}` : ""}`;

        const out = envelope(c, {
          channel: { id: target.id, name: target.name },
          count: msgs.length,
          pages,
          truncated,
          firstMessageAt: first,
          lastMessageAt: last,
        });

        if (noFile) return { ...out, messages: msgs };

        const md = toMarkdown(msgs, { title: heading });
        const dir = outDir ? path.resolve(outDir) : process.cwd();
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const safe = String(heading).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
        const file = path.join(dir, `discord-archive-${safe}-${stamp}.md`);
        fs.writeFileSync(file, md, "utf8");

        return {
          ...out,
          path: file,
          bytes: Buffer.byteLength(md, "utf8"),
        };
      },
    })
  );
  ctx.tools.register(
    defineTool({
      name: "discord_download",
      description:
        "把 Discend 附件下载到本地。Discord CDN 链接约 24 小时失效，要留存必须现在下。同时对图片/JSON 做角色卡判型（检查 chara/ccv3 数据块），避免存下一堆只有封面图的假卡。支持一次传多个 URL，也支持直接给频道名自动抓该帖主帖的附件。",
      parameters: {
        urls: {
          type: "array",
          description: "要下载的附件 URL 列表（来自 discord_messages / discord_search 的 attachments）",
          items: { type: "string" },
        },
        channel: {
          type: "string",
          description: "或给频道/帖子 ID：自动翻到主帖，下载其全部附件",
        },
        dir: {
          type: "string",
          description: "输出目录，默认当前工作目录",
        },
        inspect: {
          type: "boolean",
          description: "是否做角色卡判型，默认 true",
        },
        maxBytes: {
          type: "number",
          description: "单文件大小上限（字节），默认 52428800（50MB）",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            files: { type: "array", items: { type: "object", additionalProperties: true } },
            cards: { type: "array", items: { type: "object", additionalProperties: true } },
            failed: { type: "array", items: { type: "object", additionalProperties: true } },
            totalBytes: { type: "number" },
          },
        },
      },
      async execute({ urls, channel, dir, inspect = true, maxBytes }) {
        const out = { files: [], cards: [], failed: [], totalBytes: 0 };

        // 收集待下载的 URL
        let targets = Array.isArray(urls) ? [...urls] : [];
        if (channel) {
          const c = await primary(cfg);
          const { fetchStarter, cardCandidates: cc } = await import("./cards.js");
          const starter = await fetchStarter(c.token, String(channel).trim());
          if (starter) targets.push(...cc(starter).map((a) => a.url));
        }
        if (!targets.length) {
          throw new Error("没有可下载的 URL：给 urls 或 channel");
        }

        const root = dir ? path.resolve(dir) : process.cwd();
        for (const url of targets) {
          try {
            const r = await downloadAttachment(url, {
              dir: root,
              ...(maxBytes ? { maxBytes } : {}),
              inspect,
            });
            out.files.push({
              path: r.path,
              bytes: r.bytes,
              type: r.contentType,
              expiresAt: r.expiresAt,
            });
            out.totalBytes += r.bytes;
            if (r.card?.ok) out.cards.push({ path: r.path, ...r.card });
          } catch (e) {
            out.failed.push({ url: String(url).slice(0, 120), error: e.message });
          }
        }
        return out;
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "discord_context",
      description:
        "读某条消息前后的上下文。Discord 的 ?around= 接口一次能拿目标前后的消息，比翻页精准。搜索命中一条后想看清语境时用它。",
      parameters: {
        channelId: { type: "string", description: "频道 ID" },
        messageId: { type: "string", description: "目标消息 ID" },
        limit: { type: "number", description: "前后各取多少条，默认 6（总数约 2 倍）" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            account: { type: "object", additionalProperties: true },
            target: { type: "number" },
            count: { type: "number" },
            messages: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
      },
      async execute({ channelId, messageId, limit = 6 }) {
        const c = await primary(cfg);
        const raw = await apiGet(c.token, `/channels/${channelId}/messages`, {
          around: messageId,
          limit: Math.min(Number(limit) * 2 + 1 || 13, 100),
        });
        const names = await attachChannelNames(c.token, null, raw || []);
        const msgs = (raw || []).map((m) =>
          compactMessage(m, { channelName: names.get(m.channel_id) })
        );
        const idx = msgs.findIndex((m) => m.id === messageId);
        return envelope(c, {
          target: idx,
          count: msgs.length,
          messages: msgs,
        });
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "discord_card",
      description:
        "从 Discord 的角色卡频道随机抽一张真卡，返回可直接下载的链接。会打开每条推送的传送门、翻到帖子主帖、下载验证文件里真有 chara/ccv3 数据——因为那个频道里大部分 PNG 只是封面图。支持只从指定频道抽。",
      parameters: {
        channelId: {
          type: "string",
          description: "卡频道 ID，默认「每日新卡」1393179379126767686",
        },
        limit: {
          type: "number",
          description: "从最近多少条推送里抽，默认 100",
        },
        maxCheck: {
          type: "number",
          description:
            "最多下载校验多少个文件，默认 40。真卡比例只有约 10%，值太小会抽不到",
        },
        keyword: {
          type: "string",
          description: "只抽卡名含该关键词的",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            card: { type: "object", additionalProperties: true },
            stats: { type: "object", additionalProperties: true },
            picked: { type: "object", additionalProperties: true },
          },
        },
      },
      async execute({ channelId, limit = 100, maxCheck = 40, keyword }) {
        const c = await primary(cfg);
        const CH = String(channelId || "1393179379126767686").trim();

        const entries = await collectEntries(c.token, CH, { limit });
        const pool = keyword
          ? entries.filter((e) => String(e.title).toLowerCase().includes(String(keyword).toLowerCase()))
          : entries;

        // 逐个解析出候选文件
        const files = [];
        const owners = [];
        for (const e of pool) {
          try {
            const r = await resolveEntry(c.token, e);
            // 把解析出的 files 一起带上，否则后面按 URL 归属时永远匹配不上
            const owner = { ...e, channelName: r.channelName, starter: r.starter, files: r.files };
            for (const f of r.files) {
              files.push(f);
              owners.push(owner);
            }
          } catch {
            /* 单个帖子打不开就跳过 */
          }
          if (files.length >= maxCheck * 2) break;
        }

        const { verified, rejected, checked } = await verifyFiles(files, { maxCheck });
        const pick = pickRandom(verified);
        if (!pick) {
          // 说清为什么没抽到，别让调用方猜
          const reasons = {};
          for (const r of rejected) {
            const k = r.why || "未知";
            reasons[k] = (reasons[k] || 0) + 1;
          }
          return {
            card: null,
            stats: {
              entries: entries.length,
              pool: pool.length,
              files: files.length,
              checked,
              verified: 0,
              rejected: rejected.length,
              reasons,
              hint:
                checked < files.length
                  ? `只校验了 ${checked}/${files.length} 个，调大 maxCheck 再试`
                  : "校验完仍无真卡；换个频道或放宽 keyword",
            },
            picked: null,
          };
        }

        // 找到这张卡属于哪个 entry
        const owner = owners.find((o) => o.files?.some((f) => f.url === pick.url)) ||
          owners.find((o) => o.title === pick.title) || null;

        return {
          card: {
            name: pick.card.name || owner?.title || pick.filename,
            kind: pick.card.kind,
            spec: pick.card.spec || null,
            firstMesLen: pick.card.firstMesLen ?? null,
            bytes: pick.card.size,
            filename: pick.filename,
            downloadUrl: pick.url,
            expiresAt: urlExpiry(pick.url)?.toISOString() ?? null,
          },
          stats: {
            entries: entries.length,
            pool: pool.length,
            files: files.length,
            checked,
            verified: verified.length,
            rejected: rejected.length,
          },
          picked: owner
            ? {
                title: owner.title,
                author: owner.author,
                tags: owner.tags,
                category: owner.category,
                time: owner.time,
                threadId: owner.threadId,
                postUrl: owner.threadId
                  ? `https://discord.com/channels/${owner.starter?.guild_id || ""}/${owner.threadId}`
                  : null,
              }
            : null,
        };
      },
    })
  );

  /* ---------------- 插件 ---------------- */

  ctx.tools.register(
    defineTool({
      name: "discord_plugins",
      description:
        "列出某个服务器里像「插件/脚本区」的频道，或列出某个插件论坛里的帖子（标题+链接+是否带仓库/附件）。用来先摸清哪里有插件，再决定抽哪个。",
      parameters: {
        guildId: {
          type: "string",
          description: "服务器 ID；给了就列出疑似插件频道",
        },
        forumId: {
          type: "string",
          description: "论坛频道 ID；给了就列出该论坛的帖子",
        },
        pattern: {
          type: "string",
          description: "频道名匹配正则，默认 插件|脚本|扩展|工具|助手",
        },
        pages: {
          type: "number",
          description: "论坛翻几页（每页 25），默认 2",
        },
        scan: {
          type: "boolean",
          description: "是否逐个帖子扫描获取方式（慢，但能看到有没有 zip/仓库）",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            account: { type: "object", additionalProperties: true },
            channels: { type: "array", items: { type: "object", additionalProperties: true } },
            threads: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
      },
      async execute({ guildId, forumId, pattern, pages = 2, scan = false }) {
        const c = await primary(cfg);
        const out = {};

        if (guildId) {
          out.channels = await pluginChannels(c.token, guildId, pattern);
        }

        if (forumId) {
          const list = await listForumThreads(c.token, forumId, { pages });
          const threads = [];
          for (const t of list) {
            const base = {
              id: t.id,
              name: t.name,
              messages: t.message_count,
              archived: t.thread_metadata?.archived ?? null,
              createdAt: t.thread_metadata?.create_timestamp ?? null,
              url: `https://discord.com/channels/${t.guild_id || ""}/${t.id}`,
            };
            if (scan) {
              try {
                const r = await resolvePluginThread(c.token, t.id, { replyLimit: 20 });
                base.hasRepo = r.hasRepo;
                base.repoLinks = r.repoLinks.slice(0, 3);
                base.fileCount = r.files.length;
                base.hasArchive = r.hasArchive;
              } catch {
                /* 扫不动就留空 */
              }
            }
            threads.push(base);
          }
          out.threads = threads;
        }

        return envelope(c, out);
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "discord_plugin",
      description:
        "从 Discord 的插件区随机抽一个真插件，返回下载链接。逻辑跟抽卡类似但判型完全不同：插件 zip 里要有 manifest.json / index.js，单文件脚本要有 name+content 字段；会同时扫正文里的 GitHub/Gitee 链接和回复里的附件，因为插件常常没有直接附件。",
      parameters: {
        forumId: {
          type: "string",
          description: "插件论坛频道 ID，默认「酒馆插件及脚本区」1240569535472472126",
        },
        pages: { type: "number", description: "翻几页帖子，默认 2（每页 25）" },
        maxCheck: {
          type: "number",
          description: "最多下载校验多少个文件，默认 20",
        },
        keyword: {
          type: "string",
          description: "只抽帖名含该关键词的",
        },
        replyLimit: {
          type: "number",
          description: "每个帖子翻多少条回复找附件，默认 50",
        },
        allowRepoOnly: {
          type: "boolean",
          description: "允许抽只有仓库链接没有附件的（默认 true，会标注 kind=repo）",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            plugin: { type: "object", additionalProperties: true },
            stats: { type: "object", additionalProperties: true },
            picked: { type: "object", additionalProperties: true },
          },
        },
      },
      async execute({
        forumId,
        pages = 2,
        maxCheck = 20,
        keyword,
        replyLimit = 50,
        allowRepoOnly = true,
      }) {
        const c = await primary(cfg);
        const FORUM = String(forumId || "1240569535472472126").trim();

        const list = await listForumThreads(c.token, FORUM, { pages });
        const pool = keyword
          ? list.filter((t) => String(t.name).toLowerCase().includes(String(keyword).toLowerCase()))
          : list;

        // 逐个帖子扫描，收集文件候选 + 仓库候选
        const files = [];
        const owners = [];
        const repoOnly = [];
        for (const t of pool) {
          let r;
          try {
            r = await resolvePluginThread(c.token, t.id, { replyLimit });
          } catch {
            continue;
          }
          const owner = {
            threadId: t.id,
            title: t.name,
            url: `https://discord.com/channels/${t.guild_id || ""}/${t.id}`,
            author: r.starter?.author?.global_name || r.starter?.author?.username,
            time: r.starter?.timestamp || t.thread_metadata?.create_timestamp,
            repoLinks: r.repoLinks,
            replyCount: t.message_count,
            summary: (r.starter?.content || "").split("\n").find((l) => l.trim())?.slice(0, 120) || "",
          };
          if (r.files.length) {
            for (const f of r.files) {
              files.push(f);
              owners.push(owner);
            }
          } else if (r.hasRepo) {
            repoOnly.push(owner);
          }
          if (files.length >= maxCheck * 2) break;
        }

        const { verified, rejected, checked } = await verifyPluginFiles(files, { maxCheck });
        const pick = pickRandom(verified);

        if (!pick) {
          // 没有可下文件时，退到仓库链接
          if (allowRepoOnly && repoOnly.length) {
            const r = pickRandom(repoOnly);
            return {
              plugin: {
                name: r.title,
                kind: "repo",
                downloadUrl: r.repoLinks[0] || null,
                repoLinks: r.repoLinks,
                note: "这个帖只在正文放了仓库链接，没有附件可下",
              },
              stats: {
                threads: list.length,
                pool: pool.length,
                files: files.length,
                checked,
                verified: 0,
                rejected: rejected.length,
                repoOnly: repoOnly.length,
              },
              picked: r,
            };
          }
          const reasons = {};
          for (const x of rejected) {
            const k = x.why || "未知";
            reasons[k] = (reasons[k] || 0) + 1;
          }
          return {
            plugin: null,
            stats: {
              threads: list.length,
              pool: pool.length,
              files: files.length,
              checked,
              verified: 0,
              rejected: rejected.length,
              repoOnly: repoOnly.length,
              reasons,
              hint:
                repoOnly.length > 0
                  ? `有 ${repoOnly.length} 个帖子只放仓库链接，设 allowRepoOnly=true 可以抽这类`
                  : checked < files.length
                    ? `只校验了 ${checked}/${files.length}，调大 maxCheck`
                    : "没抽到；换个 forumId 或放宽 keyword",
            },
            picked: null,
          };
        }

        const owner = owners.find((o) => o.repoLinks?.length && o.repoLinks.some((l) => pick.url?.includes(l))) ||
          owners.find((o) => o.title === pick.title) || null;

        return {
          plugin: {
            // 文件名常常是残缺的（如 "-.json"），脚本内部 name 才是真名
            name: pick.plugin.name || pick.filename,
            filename: pick.filename,
            kind: pick.plugin.kind,
            bytes: pick.plugin.size,
            downloadUrl: pick.url,
            expiresAt: urlExpiry(pick.url)?.toISOString() ?? null,
            ...(pick.plugin.fileCount ? { fileCount: pick.plugin.fileCount } : {}),
            ...(pick.plugin.jsCount ? { jsCount: pick.plugin.jsCount } : {}),
            ...(pick.plugin.hasManifest !== undefined ? { hasManifest: pick.plugin.hasManifest } : {}),
            ...(pick.plugin.hasIndex !== undefined ? { hasIndex: pick.plugin.hasIndex } : {}),
            ...(pick.plugin.contentLen ? { contentLen: pick.plugin.contentLen } : {}),
            ...(pick.plugin.scriptType ? { scriptType: pick.plugin.scriptType } : {}),
            ...(pick.plugin.description ? { description: pick.plugin.description } : {}),
            ...(pick.plugin.scriptAuthor ? { scriptAuthor: pick.plugin.scriptAuthor } : {}),
            ...(pick.plugin.version ? { version: pick.plugin.version } : {}),
            ...(pick.plugin.enabled !== null && pick.plugin.enabled !== undefined
              ? { enabledInFile: pick.plugin.enabled }
              : {}),
            from: pick.where || null,
            ...(pick.replyAuthor ? { replyAuthor: pick.replyAuthor } : {}),
          },
          stats: {
            threads: list.length,
            pool: pool.length,
            files: files.length,
            checked,
            verified: verified.length,
            rejected: rejected.length,
            repoOnly: repoOnly.length,
          },
          picked: owner,
        };
      },
    })
  );
}
