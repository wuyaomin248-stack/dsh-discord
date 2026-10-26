/**
 * 冒烟测试：验证 token 抓取、API 调用、搜索三条链路都能跑通。
 * 直接跑 node smoke.mjs。
 */
import { harvestTokens, tokenFromEnv, maskToken, userIdFromToken } from "./lib/token.js";
import { getMe, getGuilds, getGuildChannels, getMessages } from "./lib/api.js";
import { searchGuild, snowflakeForDate, dateFromSnowflake } from "./lib/search.js";
import { compactUser, compactGuild, compactChannel, compactMessage } from "./lib/format.js";

const ok = (label, extra = "") => console.log("  ✓", label, extra);
const bad = (label, e) => console.log("  ✗", label, "—", e?.message || e);

console.log("=== 1. token 抓取 ===");
let tokens = tokenFromEnv();
let source = "env";
if (!tokens.length) {
  const { found, scanned } = await harvestTokens({ which: "auto" });
  const seen = new Set();
  tokens = found.filter((f) => !seen.has(f.token) && seen.add(f.token)).map((f) => f.token);
  source = "browser";
  console.log("  扫描:", scanned.map((s) => `${s.browser}/${s.profile}=${s.candidates}`).join(" "));
}
console.log("  找到", tokens.length, "个 token（来源", source + "）");
tokens.forEach((t, i) =>
  console.log(`    [${i}] ${maskToken(t)}  userId=${userIdFromToken(t)}`)
);

if (!tokens.length) {
  console.log("没有 token，测试中止");
  process.exit(1);
}

console.log("\n=== 2. 账号验证 ===");
let tok = null, me = null;
for (const t of tokens) {
  try {
    const u = await getMe(t);
    tok = t; me = u;
    ok("token 有效", compactUser(u).username);
    break;
  } catch (e) {
    bad("token 无效", e);
  }
}
if (!tok) process.exit(1);

console.log("\n=== 3. 服务器列表 ===");
let guilds = [];
try {
  guilds = await getGuilds(tok);
  ok(`拿到 ${guilds.length} 个服务器`);
  guilds.slice(0, 5).forEach((g) =>
    console.log("    -", compactGuild(g).name, g.id)
  );
} catch (e) {
  bad("服务器列表失败", e);
}

if (!guilds.length) {
  console.log("没有服务器，跳过后续测试");
  process.exit(0);
}

const g = guilds[0];
console.log(`\n=== 4. 频道列表（${g.name}）===`);
let channels = [];
try {
  channels = await getGuildChannels(tok, g.id);
  ok(`拿到 ${channels.length} 个频道`);
  channels.slice(0, 8).forEach((c) => {
    const cc = compactChannel(c);
    console.log(`    - ${cc.type.padEnd(18)} ${cc.name}  ${cc.id}`);
  });
} catch (e) {
  bad("频道列表失败", e);
}

const textCh = channels.find((c) => c.type === 0);
if (textCh) {
  console.log(`\n=== 5. 读消息（#${textCh.name}）===`);
  try {
    const msgs = await getMessages(tok, textCh.id, { limit: 5 });
    ok(`读到 ${msgs.length} 条`);
    msgs.slice(0, 3).forEach((m) => {
      const cm = compactMessage(m);
      console.log(`    [${cm.time}] ${cm.author}: ${(cm.content || "").slice(0, 60).replace(/\n/g, " ")}`);
    });
  } catch (e) {
    bad("读消息失败", e);
  }
}

console.log(`\n=== 6. 服务端搜索（${g.name}）===`);
try {
  const res = await searchGuild(tok, g.id, { content: "", offset: 0 });
  const flat = (res.messages || []).flatMap((x) => (Array.isArray(x) ? x : [x]));
  ok(`总命中 ${res.total_results ?? "?"} 条，本页 ${flat.length} 条`);
  if (res.documents_indexed === 0) console.log("    注意：该服务器未建立搜索索引");
  flat.slice(0, 3).forEach((m) => {
    const cm = compactMessage(m);
    console.log(`    [${cm.time}] ${cm.author}: ${(cm.content || "").slice(0, 50).replace(/\n/g, " ")}`);
  });
} catch (e) {
  bad("服务端搜索失败", e);
}

console.log("\n=== 7. snowflake 时间换算 ===");
const now = new Date("2026-10-01T00:00:00Z");
const sf = snowflakeForDate(now);
const back = dateFromSnowflake(sf);
ok("往返一致", `${now.toISOString()} -> ${sf} -> ${back?.toISOString()}`);

console.log("\n冒烟测试结束");
