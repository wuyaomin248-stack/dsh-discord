/**
 * 验证改进：频道名、命中标记、标记清洗、embed、导出。
 */
import { harvestTokens, tokenFromEnv } from "../lib/token.js";
import { getMe } from "../lib/api.js";
import { searchGuild, explicateSearchResults } from "../lib/search.js";
import { compactMessage, cleanContent, groupByChannel, toMarkdown } from "../lib/format.js";

const GUILD = "1134557553011998840";
let tokens = tokenFromEnv();
if (!tokens.length) {
  const { found } = await harvestTokens({ which: "auto" });
  const seen = new Set();
  tokens = found.filter((f) => !seen.has(f.token) && seen.add(f.token)).map((f) => f.token);
}
let tok = null;
for (const t of tokens) { try { await getMe(t); tok = t; break; } catch { /* next */ } }
if (!tok) { console.log("无 token"); process.exit(1); }

console.log("=== 1. cleanContent 标记清洗 ===");
const cases = [
  ["<@1400045042349113394> 你好", { mentions: [{ id: "1400045042349113394", global_name: "类脑娘" }] }],
  ["<@123456789012345678> 未知用户", {}],
  ["看这个 <:shy:1425170441739436032> 表情", {}],
  ["<#1134557553464987788> 频道", {}],
  ["<t:1761408000:R> 时间", {}],
];
for (const [input, msg] of cases) {
  console.log(`  ${input}`);
  console.log(`  → ${cleanContent(input, msg)}`);
}

console.log("\n=== 2. 搜索结果：命中识别 + 频道名 ===");
const res = await searchGuild(tok, GUILD, { content: "Claude" });
const groups = explicateSearchResults(res);
console.log(`  组数 ${groups.length}`);
console.log(`  命中标记: ${groups.filter((g) => g.hit).length}`);
const withCtx = groups.filter((g) => g.context.length);
console.log(`  带上下文 ${withCtx.length} 组`);
if (withCtx[0]) {
  console.log(`  示例命中: ${(withCtx[0].message.content || "").slice(0, 50)}`);
  console.log(`  其上下文: ${withCtx[0].context.map((c) => (c.content || "").slice(0, 30)).join(" | ")}`);
}

// 补频道名——复刻插件里的补名逻辑（帖子要逐个查）
const { getGuildChannels, getChannel } = await import("../lib/api.js");
const chs = await getGuildChannels(tok, GUILD);
const names = new Map(chs.map((c) => [c.id, c.name]));
const missing = [...new Set(groups.map((g) => g.message.channel_id))].filter(
  (id) => !names.has(id)
);
console.log(`\n  频道列表缺 ${missing.length} 个（帖子类），逐个补:`);
for (const id of missing) {
  try {
    const ch = await getChannel(tok, id);
    if (ch?.name) {
      names.set(id, ch.name);
      console.log(`    ✓ ${id} → ${ch.name} (type=${ch.type})`);
    }
  } catch (e) {
    console.log(`    ✗ ${id} 失败: ${e.message}`);
  }
}

const msgs = groups.map(({ message, context }) =>
  Object.assign(
    compactMessage(message, { channelName: names.get(message.channel_id) }),
    context.length ? { context: context.slice(0, 2) } : {}
  )
);
const unnamed = msgs.filter((m) => !m.channel).length;
console.log(`\n  补齐后仍无名: ${unnamed} / ${msgs.length}`);
console.log("  前 3 条:");
msgs.slice(0, 3).forEach((m) =>
  console.log(`    [${m.channel || "(无名)"}] ${m.author}: ${m.content.slice(0, 40)}`)
);
console.log("\n  byChannel 分组:");
groupByChannel(msgs).slice(0, 6).forEach((g) =>
  console.log(`    ${g.channel}: ${g.count} 条`)
);

console.log("\n=== 3. embed 是否保留 ===");
const withEmbed = msgs.filter((m) => m.embeds?.length);
console.log(`  带 embed ${withEmbed.length} 条`);
if (withEmbed[0]) console.log("  ", JSON.stringify(withEmbed[0].embeds[0]).slice(0, 150));

console.log("\n=== 4. Markdown 导出 ===");
const md = toMarkdown(msgs.slice(0, 3), { title: "测试导出" });
console.log(md.split("\n").slice(0, 14).map((l) => "  " + l).join("\n"));
console.log(`  ... 共 ${md.length} 字符`);

console.log("\n=== 5. 全是表情的消息（验证不崩）===");
const emojiOnly = msgs.find((m) => m.content && m.content.length < 8);
console.log("  ", JSON.stringify(emojiOnly?.content));
