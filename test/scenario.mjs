/**
 * 场景测试：模拟用户真实用法——搜索关键词、按时间筛、跨频道找。
 */
import { harvestTokens, tokenFromEnv } from "../lib/token.js";
import { getMe, getGuilds, getGuildChannels } from "../lib/api.js";
import { searchGuild, filterChannel, filterGuild, snowflakeForDate } from "../lib/search.js";
import { compactMessage, compactChannel } from "../lib/format.js";

const GUILD = "1134557553011998840"; // 类脑ΟΔΥΣΣΕΙΑ

let tokens = tokenFromEnv();
if (!tokens.length) {
  const { found } = await harvestTokens({ which: "auto" });
  const seen = new Set();
  tokens = found.filter((f) => !seen.has(f.token) && seen.add(f.token)).map((f) => f.token);
}
let tok = null;
for (const t of tokens) {
  try { await getMe(t); tok = t; break; } catch { /* next */ }
}
if (!tok) { console.log("无可用 token"); process.exit(1); }

const show = (msgs, n = 5) =>
  msgs.slice(0, n).forEach((m) => {
    const c = compactMessage(m);
    console.log(`    [${c.time?.slice(0, 16)}] ${c.author}: ${(c.content || "").slice(0, 70).replace(/\n/g, " ")}`);
  });

console.log("=== A. 关键词搜索：Claude ===");
try {
  const r = await searchGuild(tok, GUILD, { content: "Claude", sort: "timestamp" });
  const flat = (r.messages || []).flatMap((x) => (Array.isArray(x) ? x : [x]));
  console.log(`  总命中 ${r.total_results} 条，本页 ${flat.length}`);
  show(flat);
} catch (e) { console.log("  失败:", e.message); }

console.log("\n=== B. 按时间范围：最近 7 天含 \"模型\" ===");
try {
  const since = snowflakeForDate(new Date(Date.now() - 7 * 864e5));
  const r = await searchGuild(tok, GUILD, { content: "模型", minId: since });
  const flat = (r.messages || []).flatMap((x) => (Array.isArray(x) ? x : [x]));
  console.log(`  总命中 ${r.total_results} 条，本页 ${flat.length}`);
  show(flat);
} catch (e) { console.log("  失败:", e.message); }

console.log("\n=== C. 排序对比：relevance vs timestamp ===");
try {
  const [a, b] = await Promise.all([
    searchGuild(tok, GUILD, { content: "报错", sort: "relevance" }),
    searchGuild(tok, GUILD, { content: "报错", sort: "timestamp" }),
  ]);
  console.log("  relevance 首条:", compactMessage((a.messages || []).flat()[0])?.content?.slice(0, 60));
  console.log("  timestamp 首条:", compactMessage((b.messages || []).flat()[0])?.content?.slice(0, 60));
} catch (e) { console.log("  失败:", e.message); }

console.log("\n=== D. 本地过滤（正则）===");
try {
  const channels = await getGuildChannels(tok, GUILD);
  const text = channels.filter((c) => c.type === 0 && !c.nsfw).slice(0, 3);
  for (const ch of text) {
    const { hits, scanned } = await filterChannel(tok, ch.id, {
      pattern: "https?://", regex: true, limit: 3, scan: 200,
    });
    console.log(`  #${ch.name}: 扫 ${scanned} 条，命中 ${hits.length}`);
    show(hits, 2);
  }
} catch (e) { console.log("  失败:", e.message); }

console.log("\n=== E. 跨频道扫 ===");
try {
  const groups = await filterGuild(tok, GUILD, {
    pattern: "部署", maxChannels: 4, scanPerChannel: 150, limit: 3,
  });
  const total = groups.reduce((n, g) => n + g.hits.length, 0);
  console.log(`  扫 ${groups.length} 个频道，总命中 ${total}`);
  groups.filter((g) => g.hits.length).forEach((g) => {
    console.log(`  #${g.channelName}: ${g.hits.length} 条`);
    show(g.hits, 1);
  });
} catch (e) { console.log("  失败:", e.message); }

console.log("\n场景测试结束");
