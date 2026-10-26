/** 实测 discord_archive：拉整个频道/帖子历史并落盘。 */
const reg = [];
const ctx = { logger:{info(){},warn(){},error(){}}, effect(){}, tools:{register(t){reg.push(t);return()=>{}}} };
const m = await import("./lib/index.js");
m.apply(ctx, {});
const T = (n) => reg.find((t) => t.name === n);

console.log("=== 1. 归档一个论坛帖子（小量）===");
try {
  const r = await T("discord_archive").execute({
    channel: "1240569535472472126",   // 插件区论坛（本身能读吗）
    maxMessages: 100,
    outDir: "E:\\jiugaun\\_arch-test",
    title: "测试归档",
    noFile: true,
  });
  console.log("  条数:", r.count, "| 页:", r.pages, "| 截断:", r.truncated);
  console.log("  时间范围:", r.firstMessageAt, "→", r.lastMessageAt);
} catch (e) {
  console.log("  ✗", e.status, e.message.slice(0, 70));
}

console.log("\n=== 2. 归档一个真实帖子（有消息的 thread）===");
try {
  const r = await T("discord_archive").execute({
    channel: "1462830042768740414",   // 【QR助手】帖子
    maxMessages: 300,
    outDir: "E:\\jiugaun\\_arch-test",
    title: "QR助手帖子归档",
  });
  console.log("  条数:", r.count, "| 页:", r.pages, "| 截断:", r.truncated);
  console.log("  时间:", r.firstMessageAt?.slice(0,16), "→", r.lastMessageAt?.slice(0,16));
  console.log("  文件:", r.path);
  console.log("  大小:", r.bytes, "B");
} catch (e) {
  console.log("  ✗", e.status, e.message.slice(0, 70));
}

console.log("\n=== 3. 带时间范围 ===");
try {
  const r = await T("discord_archive").execute({
    channel: "1462830042768740414",
    maxMessages: 500,
    since: "2026-10-01",
    noFile: true,
  });
  console.log("  2026-10-01 之后:", r.count, "条 | 截断:", r.truncated);
  console.log("  最早:", r.firstMessageAt?.slice(0,16));
} catch (e) {
  console.log("  ✗", e.status, e.message.slice(0, 70));
}

console.log("\n=== 4. 条数上限生效验证 ===");
try {
  const r = await T("discord_archive").execute({
    channel: "1462830042768740414",
    maxMessages: 50,
    noFile: true,
  });
  console.log("  要 50 条，拿到:", r.count, "| truncated:", r.truncated, "| pages:", r.pages);
} catch (e) {
  console.log("  ✗", e.status, e.message.slice(0, 70));
}
