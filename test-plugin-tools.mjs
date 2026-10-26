/** 实测插件发现工具。 */
const reg = [];
const ctx = {
  logger: { info() {}, warn: console.warn, error: console.error },
  effect() {},
  tools: { register(t) { reg.push(t); return () => {}; } },
};
const m = await import("./lib/index.js");
m.apply(ctx, {});
const T = (n) => reg.find((t) => t.name === n);

console.log("=== 1. discord_plugins：列出插件频道 ===");
try {
  const r = await T("discord_plugins").execute({
    guildId: "1134557553011998840",
  });
  console.log("  疑似插件频道:", r.channels?.length);
  for (const ch of (r.channels || []).slice(0, 8)) {
    console.log(`    [${ch.type}] #${ch.name}  ${ch.id}`);
  }
} catch (e) {
  console.log("  ✗", e.message);
}

console.log("\n=== 2. discord_plugins：列论坛帖子（带扫描）===");
try {
  const r = await T("discord_plugins").execute({
    forumId: "1240569535472472126",
    pages: 1,
    scan: true,
  });
  console.log("  帖子数:", r.threads?.length);
  let withFile = 0, withRepo = 0, none = 0;
  for (const t of r.threads || []) {
    if (t.hasArchive) withFile += 1;
    else if (t.hasRepo) withRepo += 1;
    else none += 1;
  }
  console.log(`  带 zip: ${withFile}  只有仓库: ${withRepo}  两者都无: ${none}`);
  for (const t of (r.threads || []).slice(0, 6)) {
    const tag = t.hasArchive ? "📦" : t.hasRepo ? "🔗" : "—";
    console.log(`    ${tag} ${t.name.slice(0, 42)}`);
    if (t.repoLinks?.length) console.log(`        ${t.repoLinks[0].slice(0, 70)}`);
  }
} catch (e) {
  console.log("  ✗", e.message);
}

console.log("\n=== 3. discord_plugin：随机抽一个插件 ===");
try {
  const r = await T("discord_plugin").execute({ pages: 2, maxCheck: 20 });
  console.log("  统计:", JSON.stringify(r.stats));
  if (r.plugin) {
    console.log("  插件:", r.plugin.name);
    console.log("  类型:", r.plugin.kind);
    console.log("  大小:", (r.plugin.bytes / 1024).toFixed(0), "KB");
    if (r.plugin.fileCount) console.log("  文件数:", r.plugin.fileCount, "| js:", r.plugin.jsCount);
    if (r.plugin.hasManifest !== undefined) console.log("  manifest:", r.plugin.hasManifest);
    console.log("  来源:", r.plugin.from);
    console.log("  到期:", r.plugin.expiresAt);
    console.log("  链接:", String(r.plugin.downloadUrl).slice(0, 100));
    if (r.picked) {
      console.log("  帖子:", r.picked.title?.slice(0, 50));
      console.log("  作者:", r.picked.author);
    }
  } else {
    console.log("  未抽到，原因:", JSON.stringify(r.stats.reasons), r.stats.hint);
  }
} catch (e) {
  console.log("  ✗", e.message);
}
