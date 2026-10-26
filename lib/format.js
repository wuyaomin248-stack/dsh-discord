/**
 * 把 Discord 的原始对象压成适合 agent 读的紧凑形状。
 *
 * 原则：只留搜索和阅读用得上的字段，去掉 UI 相关的噪音。
 * 消息正文保留原文，但把 Discord 的原始标记转成可读形式——
 * `<@123456>` 这种对人和对模型都是噪音。
 */
import { dateFromSnowflake } from "./search.js";

/**
 * 把消息正文里的 Discord 标记转成可读文本。
 *
 * 只做纯文本替换，不查 API：提及换成用户名（能从 mentions 里查到的），
 * 查不到的保留 ID 但换成 `@id` 形状，至少不再是尖括号噪音。
 *
 * @param {string} content 原始正文
 * @param {object} msg 原始消息（用来从 mentions 里取用户名）
 */
export function cleanContent(content, msg = {}) {
  if (!content) return "";
  let s = String(content);

  // 能从消息自带的 mentions 数组里查到名字的，直接换名字
  const userMap = new Map();
  for (const u of msg.mentions || []) {
    userMap.set(u.id, u.global_name || u.username || u.id);
  }

  // 用户提及 <@123> / <@!123>
  s = s.replace(/<@!?(\d+)>/g, (_, id) => {
    const name = userMap.get(id);
    return name ? `@${name}` : `@${id}`;
  });

  // 角色提及 <@&123>
  s = s.replace(/<@&(\d+)>/g, (_, id) => `@role:${id}`);

  // 频道引用 <#123>
  s = s.replace(/<#(\d+)>/g, (_, id) => `#${id}`);

  // 自定义表情 <:name:id> / 动画 <a:name:id> → :name:
  // 表情名可以是 letter_a、x.y、中文等，\w 不够，要放宽到除 : 和 > 之外的字符
  s = s.replace(/<a?:([^:<>]{1,60}):\d+>/g, (_, name) => `:${name}:`);

  // 时间戳 <t:1700000000:R> → ISO 时间
  s = s.replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_, ts) => {
    const d = new Date(Number(ts) * 1000);
    return Number.isNaN(d.getTime()) ? `[time:${ts}]` : d.toISOString();
  });

  // 斜杠命令 </name:id>
  s = s.replace(/<\/([\w-]+):\d+>/g, (_, name) => `/${name}`);

  // 兜底：剩下形如 <xxx:数字> 的没人认领的标记，只留名字部分
  s = s.replace(/<([^<>\s:]{1,60}):\d+>/g, (_, name) => `:${name}:`);

  return s;
}

/** 消息 → 精简对象。 */
export function compactMessage(m, { channelName, hit } = {}) {
  const d = dateFromSnowflake(m.id);
  const out = {
    id: m.id,
    channelId: m.channel_id,
    ...(channelName ? { channel: channelName } : {}),
    author: m.author?.global_name || m.author?.username || "unknown",
    authorId: m.author?.id,
    bot: m.author?.bot || false,
    time: d ? d.toISOString() : null,
    content: cleanContent(m.content, m),
  };

  // Discord 搜索会在命中那条上打 hit: true
  if (hit !== undefined ? hit : m.hit) out.hit = true;

  if (m.attachments?.length) {
    out.attachments = m.attachments.map((a) => ({
      name: a.filename,
      size: a.size,
      type: a.content_type || null,
      url: a.url,
    }));
  }

  // embed 常带链接预览的标题和摘要，信息量比正文还大，不能丢。
  // embed 里的文字同样带 Discord 标记（表情、提及），必须一起洗。
  if (m.embeds?.length) {
    out.embeds = m.embeds.slice(0, 3).map((e) => ({
      ...(e.type ? { type: e.type } : {}),
      ...(e.title ? { title: cleanContent(e.title, m) } : {}),
      ...(e.url ? { url: e.url } : {}),
      ...(e.description
        ? { description: cleanContent(String(e.description), m).slice(0, 500) }
        : {}),
      ...(e.provider?.name ? { provider: e.provider.name } : {}),
    }));
  }

  if (m.reactions?.length) {
    out.reactions = m.reactions
      .slice(0, 5)
      .map((r) => `${r.emoji?.name ?? "?"}×${r.count}`);
  }

  // 贴纸：正文为空时至少能看出发的是什么，否则整条消息像空的
  if (m.sticker_items?.length) {
    out.stickers = m.sticker_items.map((s) => s.name).filter(Boolean);
  }

  // 投票：问题 + 选项 + 当前票数（results 里带 answer_counts）
  if (m.poll) {
    const counts = new Map(
      (m.poll.results?.answer_counts || []).map((c) => [c.id, c.count])
    );
    out.poll = {
      question: m.poll.question?.text || null,
      ...(m.poll.allow_multiselect ? { multi: true } : {}),
      ...(m.poll.expiry ? { expiry: m.poll.expiry } : {}),
      finalized: m.poll.results?.is_finalized ?? false,
      answers: (m.poll.answers || []).map((a) => ({
        text: a.poll_media?.text || null,
        ...(a.poll_media?.emoji?.name ? { emoji: a.poll_media.emoji.name } : {}),
        votes: counts.get(a.answer_id) ?? 0,
      })),
    };
  }

  // 转发快照：转发的消息本体在 message_snapshots 里，不展开就只剩一条空壳
  if (m.message_snapshots?.length) {
    const snap = m.message_snapshots[0]?.message;
    if (snap) {
      out.forwarded = {
        content: cleanContent(snap.content || "", snap).slice(0, 300),
        ...(snap.attachments?.length
          ? { attachments: snap.attachments.length }
          : {}),
        ...(snap.timestamp ? { time: snap.timestamp } : {}),
      };
    }
  }

  // 非默认消息类型（加群/置顶/boost/系统提示）：正文常为空，必须标出来
  const tname = MESSAGE_TYPES[m.type ?? 0];
  if (tname) out.type = tname;

  if (m.referenced_message) out.replyTo = m.referenced_message.id;
  if (m.thread) out.threadId = m.thread.id;
  if (m.edited_timestamp) out.edited = true;

  return out;
}

/** 非 0 的消息类型：只在出现时标注，常规聊天不输出。 */
const MESSAGE_TYPES = {
  1: "recipient-add",
  2: "recipient-remove",
  4: "channel-name-change",
  5: "channel-icon-change",
  6: "pin",
  7: "join",
  8: "boost",
  9: "boost-tier1",
  10: "boost-tier2",
  11: "boost-tier3",
  12: "channel-follow",
  14: "guild-discovery-disqualified",
  15: "guild-discovery-requalified",
  22: "invite-reminder",
  24: "context-menu-command",
  25: "auto-moderation",
  36: "poll-result",
};

/** 频道 → 精简对象。 */
export function compactChannel(c) {
  return {
    id: c.id,
    name: c.name,
    type: channelTypeName(c.type),
    ...(c.parent_id ? { parentId: c.parent_id } : {}),
    ...(c.topic ? { topic: c.topic } : {}),
    ...(c.nsfw ? { nsfw: true } : {}),
    ...(c.position !== undefined ? { position: c.position } : {}),
  };
}

/** 服务器 → 精简对象。 */
export function compactGuild(g) {
  return {
    id: g.id,
    name: g.name,
    ...(g.owner ? { owner: true } : {}),
    ...(g.approximate_member_count
      ? { members: g.approximate_member_count }
      : {}),
    ...(g.approximate_presence_count
      ? { online: g.approximate_presence_count }
      : {}),
    ...(g.description ? { description: g.description } : {}),
    ...(g.permissions ? { permissions: g.permissions } : {}),
  };
}

/** 成员 → 精简对象。 */
export function compactMember(m) {
  const u = m.user || m;
  return {
    id: u.id,
    username: u.username,
    ...(u.global_name ? { displayName: u.global_name } : {}),
    ...(m.nick ? { nick: m.nick } : {}),
    ...(u.bot ? { bot: true } : {}),
    ...(m.roles?.length ? { roles: m.roles } : {}),
    ...(m.joined_at ? { joinedAt: m.joined_at } : {}),
  };
}

/** 账号 → 精简对象。 */
export function compactUser(u) {
  return {
    id: u.id,
    username: u.username,
    ...(u.global_name ? { displayName: u.global_name } : {}),
    ...(u.email ? { email: u.email } : {}),
    ...(u.verified !== undefined ? { verified: u.verified } : {}),
    ...(u.mfa_enabled !== undefined ? { mfa: u.mfa_enabled } : {}),
    ...(u.premium_type ? { nitro: u.premium_type } : {}),
  };
}

const CHANNEL_TYPES = {
  0: "text",
  1: "dm",
  2: "voice",
  3: "group-dm",
  4: "category",
  5: "announcement",
  10: "announcement-thread",
  11: "public-thread",
  12: "private-thread",
  13: "stage",
  14: "directory",
  15: "forum",
  16: "media",
};

export function channelTypeName(t) {
  return CHANNEL_TYPES[t] || `type-${t}`;
}

/**
 * 把搜索结果按频道名分组。
 *
 * 传入的 messages 应该已经带 channel（名字）；只有 ID 的会退回用 ID，
 * 这样至少不会崩，但调用方应尽量先补名字。
 */
export function groupByChannel(messages) {
  const map = new Map();
  for (const m of messages) {
    const key = m.channel || m.channelId || "unknown";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return [...map.entries()]
    .map(([channel, items]) => ({
      channel,
      count: items.length,
      messages: items,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 把消息数组导成 Markdown。
 *
 * 用途：搜到的内容要落地成文件时，直接可读可贴。
 */
export function toMarkdown(messages, { title = "Discord 导出" } = {}) {
  const lines = [`# ${title}`, ""];
  let lastChannel = null;
  for (const m of messages) {
    if (m.channel && m.channel !== lastChannel) {
      lines.push(`## ${m.channel}`, "");
      lastChannel = m.channel;
    }
    const when = m.time ? m.time.slice(0, 16).replace("T", " ") : "?";
    lines.push(`**${m.author}** · ${when}${m.hit ? " · 命中" : ""}`);
    lines.push("");
    lines.push(m.content || "*(空)*");
    if (m.embeds?.length) {
      for (const e of m.embeds) {
        lines.push("");
        lines.push(`> ${e.title || e.type || "embed"}${e.url ? ` — ${e.url}` : ""}`);
        if (e.description) lines.push(`> ${e.description}`);
      }
    }
    if (m.attachments?.length) {
      lines.push("");
      for (const a of m.attachments) lines.push(`- 附件: [${a.name}](${a.url})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
