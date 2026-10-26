/**
 * 角色卡相关：从频道/论坛里找卡、抽卡。
 *
 * 这个社区发卡的套路：论坛帖子首条消息挂附件，但里面常常混着封面图。
 * 实测「每日新卡」推送的 40 个候选文件里只有 4 个是真卡（10%）。
 * 所以挑卡不能看文件名，必须下载验证 chara/ccv3 数据。
 */
import fs from "node:fs";
import os from "node:os";
import { getMessages, getGuildChannels, getChannel } from "./api.js";
import { downloadAttachment } from "./download.js";

/**
 * 翻到一个频道/帖子的最早消息（= 主帖）。
 *
 * 论坛帖子（type 11/12）的卡挂在主帖上，而 getMessages 默认返回最近的消息，
 * 所以要一路 before 翻到头。
 */
export async function fetchStarter(token, channelId, { maxPages = 6 } = {}) {
  let batch = await getMessages(token, channelId, { limit: 100 });
  if (!batch.length) return null;
  let first = batch[batch.length - 1];
  let pages = 1;
  while (batch.length === 100 && pages < maxPages) {
    pages += 1;
    const older = await getMessages(token, channelId, { limit: 100, before: first.id });
    if (!older.length) break;
    batch = older;
    first = batch[batch.length - 1];
  }
  return first;
}

/** 从一条消息里挑出可能是卡的文件（按扩展名）。 */
export function cardCandidates(msg) {
  return (msg?.attachments || []).filter((a) =>
    /\.(png|webp|json)$/i.test(a.filename || "")
  );
}

/**
 * 从一个频道的推送里收集「卡条目」。
 *
 * 支持两种形态：
 *   - 直接带附件（普通频道）
 *   - embed 带传送门链到论坛帖子（推送机器人）
 */
export async function collectEntries(token, channelId, { limit = 100 } = {}) {
  const msgs = await getMessages(token, channelId, { limit });
  const entries = [];

  for (const m of msgs) {
    // 形态 A：消息自己带附件
    const own = cardCandidates(m);
    if (own.length) {
      entries.push({
        source: "attachment",
        threadId: null,
        msg: m,
        title: (m.content || "").split("\n")[0].slice(0, 120) || own[0].filename,
        author: m.author?.global_name || m.author?.username,
        time: m.timestamp,
        files: own,
        tags: "",
        category: "",
      });
    }

    // 形态 B：embed 里带传送门
    for (const e of m.embeds || []) {
      const title = String(e.description || "").split("\n")[0]
        .replace(/^\*\*|\*\*$/g, "").trim();
      const portal = (e.fields || []).find((f) => /传送门|链接|原帖/.test(f.name || ""));
      const link = (portal?.value || "").match(/\(https?:\/\/([^)]+)\)/)?.[1];
      const tid = link?.match(/channels\/(\d+)\/(\d+)/)?.[2];
      if (!tid) continue;
      entries.push({
        source: "portal",
        threadId: tid,
        msg: m,
        title: title || String(e.title || "").slice(0, 120),
        author: e.author?.name || m.author?.username,
        time: e.timestamp || m.timestamp,
        files: [],
        tags: (e.fields || []).find((f) => /标签/.test(f.name || ""))?.value || "",
        category: e.footer?.text || "",
      });
    }
  }
  return entries;
}

/**
 * 把 entry 解析成真实的候选文件列表（打开传送门 → 翻主帖）。
 */
export async function resolveEntry(token, entry, { maxCards = 12 } = {}) {
  if (entry.source === "attachment") {
    return { ...entry, files: entry.files.slice(0, maxCards) };
  }
  const ch = await getChannel(token, entry.threadId);
  if (ch.type !== 11 && ch.type !== 12) {
    // 不是帖子，当普通频道翻主帖
    const starter = await fetchStarter(token, entry.threadId);
    return { ...entry, channelName: ch.name, starter, files: cardCandidates(starter).slice(0, maxCards) };
  }
  const starter = await fetchStarter(token, entry.threadId);
  return {
    ...entry,
    channelName: ch.name,
    starter,
    files: cardCandidates(starter).slice(0, maxCards),
  };
}

/**
 * 验证一批文件是不是真卡。只下载不保留。
 *
 * 返回 { verified: [...], rejected: [...] }
 */
export async function verifyFiles(files, { maxCheck = 20, onProgress } = {}) {
  const verified = [];
  const rejected = [];
  let checked = 0;

  for (const f of files) {
    if (checked >= maxCheck) break;
    checked += 1;
    try {
      const r = await downloadAttachment(f.url, {
        dir: os.tmpdir(),
        filename: `v-${checked}-${f.filename}`,
        maxBytes: 80 * 1024 * 1024,
        inspect: true,
      });
      const card = r.card;
      // 验完即删，不占磁盘
      try { fs.unlinkSync(r.path); } catch { /* 删不掉就算了 */ }
      if (card?.ok) {
        verified.push({ ...f, card });
        onProgress?.(`✓ [${card.kind}] ${card.name || f.filename}`);
      } else {
        rejected.push({ ...f, why: card?.why || "未能识别" });
        onProgress?.(`✗ ${f.filename} — ${card?.why || "未能识别"}`);
      }
    } catch (e) {
      rejected.push({ ...f, why: e.message });
      onProgress?.(`✗ ${f.filename} — ${e.message}`);
    }
  }
  return { verified, rejected, checked };
}

/** 从已验证的卡里真随机取一张。 */
export function pickRandom(verified) {
  if (!verified.length) return null;
  return verified[Math.floor(Math.random() * verified.length)];
}

/**
 * 收集一个服务器里所有「看起来在发卡」的频道。
 * 论坛（type 15）里的帖子只能在拿到 thread id 后才能读，所以这里返回
 * 论坛频道本身，供调用方用 archived 接口列举。
 */
export async function cardChannels(token, guildId, pattern) {
  const chs = await getGuildChannels(token, guildId);
  const re = pattern ? new RegExp(pattern, "i") : null;
  return chs
    .filter((c) => [0, 5, 15].includes(c.type))
    .filter((c) => (re ? re.test(c.name || "") : true))
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type === 15 ? "forum" : c.type === 5 ? "announcement" : "text",
      parentId: c.parent_id ?? null,
    }));
}
