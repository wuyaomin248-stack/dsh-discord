/**
 * 加载测试：模拟 DSH 的 ctx，验证插件能正常 apply 并注册所有工具。
 * 这一步比接口通不通更重要——插件加载失败的话，前面所有测试都白做。
 */
const registered = [];

const fakeCtx = {
  logger: { info: () => {}, warn: console.warn, error: console.error },
  effect: () => {},
  tools: {
    register(tool) {
      registered.push(tool);
      return () => {};
    },
  },
};

console.log("=== 1. import 插件模块 ===");
const mod = await import("./lib/index.js");
console.log("  name:", mod.name);
console.log("  inject:", JSON.stringify(mod.inject));
console.log("  Config 存在:", typeof mod.Config === "function" || typeof mod.Config === "object");
console.log("  apply 存在:", typeof mod.apply === "function");

console.log("\n=== 2. 校验 Config schema ===");
try {
  const cfg = mod.Config({});
  console.log("  默认配置:", JSON.stringify(cfg));
} catch (e) {
  console.log("  ✗ Config 校验失败:", e.message);
}

console.log("\n=== 3. apply 注册工具 ===");
try {
  mod.apply(fakeCtx, {});
  console.log("  注册了", registered.length, "个工具:");
  for (const t of registered) {
    console.log("    -", t.name);
    if (!t.name || !t.description) {
      console.log("      ✗ 缺 name 或 description");
    }
  }
} catch (e) {
  console.log("  ✗ apply 失败:", e.message);
  console.log(e.stack);
  process.exit(1);
}

console.log("\n=== 4. 检查工具定义完整性 ===");
let bad = 0;
for (const t of registered) {
  const issues = [];
  if (!t.name) issues.push("无 name");
  if (!t.description) issues.push("无 description");
  if (!t.parameters) issues.push("无 parameters");
  if (typeof t.execute !== "function") issues.push("无 execute");
  if (issues.length) {
    console.log("  ✗", t.name || "(匿名)", issues.join(", "));
    bad++;
  }
}
if (!bad) console.log("  ✓ 全部", registered.length, "个工具定义完整");

console.log("\n=== 5. 实调一个只读工具（discord_servers）===");
const tool = registered.find((t) => t.name === "discord_servers");
if (!tool) {
  console.log("  ✗ 没找到 discord_servers");
  process.exit(1);
}
try {
  const res = await tool.execute({});
  console.log("  ✓ 调用成功");
  console.log("  账号:", res.account?.username);
  console.log("  服务器数:", res.servers?.length);
  res.servers?.slice(0, 3).forEach((s) => console.log("    -", s.name, s.id));
} catch (e) {
  console.log("  ✗ 调用失败:", e.message);
}

console.log("\n=== 6. 实调搜索工具（discord_search）===");
const st = registered.find((t) => t.name === "discord_search");
if (st) {
  try {
    const res = await st.execute({
      guildId: "1134557553011998840",
      query: "LCP",
      sort: "timestamp",
    });
    console.log("  ✓ 搜索成功，总命中", res.total);
    console.log("  本页", res.messages?.length, "条，分", res.byChannel?.length, "个频道");
    res.messages?.slice(0, 2).forEach((m) =>
      console.log(`    [${m.time?.slice(0, 16)}] ${m.author}: ${(m.content || "").slice(0, 50)}`)
    );
  } catch (e) {
    console.log("  ✗ 搜索失败:", e.message);
  }
}

console.log("\n=== 7. 参数错误处理 ===");
const chTool = registered.find((t) => t.name === "discord_channels");
try {
  await chTool.execute({ guildId: "000000000000000000" });
  console.log("  ✗ 无效 guildId 居然成功了");
} catch (e) {
  console.log("  ✓ 无效 guildId 正确报错:", e.message.slice(0, 60));
}

console.log("\n加载测试结束");
process.exit(0);
