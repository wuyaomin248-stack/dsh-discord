/** 实调 discord_export，验证落盘文件内容。 */
const registered = [];
const fakeCtx = {
  logger: { info: () => {}, warn: console.warn, error: console.error },
  effect: () => {},
  tools: { register(t) { registered.push(t); return () => {}; } },
};

const mod = await import("./lib/index.js");
mod.apply(fakeCtx, {});

const tool = registered.find((t) => t.name === "discord_export");
if (!tool) { console.log("✗ 没有 discord_export"); process.exit(1); }

const res = await tool.execute({
  guildId: "1134557553011998840",
  query: "Kimi",
  pages: 2,
  outDir: "E:\\jiugaun\\_discord-export",
  title: "Kimi 相关讨论",
});

console.log("=== 导出结果 ===");
console.log("  路径:", res.path);
console.log("  大小:", res.bytes, "B");
console.log("  本页消息:", res.count, " 总命中:", res.total);

const fs = await import("node:fs");
const md = fs.readFileSync(res.path, "utf8");
console.log("\n=== 文件开头 ===");
console.log(md.split("\n").slice(0, 20).map((l) => "  " + l).join("\n"));

console.log("\n=== 结构检查 ===");
console.log("  频道分组数:", (md.match(/^## /gm) || []).length);
console.log("  消息条数:", (md.match(/^\*\*/gm) || []).length);
console.log("  含 embed 引用:", md.includes("> "));
console.log("  含 Discord 原始标记:", /<[@#:]/.test(md));
