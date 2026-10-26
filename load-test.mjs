/**
 * 加载测试：模拟 DSH 的 ctx，验证插件能正常 apply 并注册所有工具。
 * 这一步比接口通不通更重要——插件加载失败的话，前面所有测试都白做。
 */
const registered = [];

/**
 * 模拟宿主的 output 白名单校验（0.5.0/0.5.1 两次事故的回归网）。
 * 语义对齐 dsh-tools 的 validateJsonSchemaValue：
 *   - type:object 遇 null/数组 → "must be an object"（null 不是 plain record）
 *   - type:string 遇 null → "must be a string"
 *   - additionalProperties:false → 未声明字段报错
 *   - type:json / 无 type → 放行任意值
 */
function validateOut(value, schema, path = "value") {
  if (!schema || typeof schema !== "object") return [];
  const t = schema.type;
  if (t === undefined || t === "json") return [];

  if (t === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      const got = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      return [`${path} must be an object (got ${got})`];
    }
    const props = schema.properties || {};
    const errs = [];
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) errs.push(`${path}.${k} is not a declared property`);
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (value[k] !== undefined) errs.push(...validateOut(value[k], sub, `${path}.${k}`));
    }
    return errs;
  }
  if (t === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    const errs = [];
    value.forEach((v, i) => errs.push(...validateOut(v, schema.items, `${path}[${i}]`)));
    return errs;
  }
  if (t === "string") return typeof value === "string" ? [] : [`${path} must be a string`];
  if (t === "number" || t === "integer") {
    return typeof value === "number" ? [] : [`${path} must be a number`];
  }
  if (t === "boolean") return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
  if (t === "null") return value === null ? [] : [`${path} must be null`];
  return [];
}

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

console.log("\n=== 4.5 校验器自检（防 null/白名单漏网）===");
{
  // [值, schema, 期望是否有错, 说明]
  const cases = [
    [{ card: null }, { type: "object", additionalProperties: false, properties: { card: { type: "object", additionalProperties: true } } }, true, "object 遇 null 应报错"],
    [{ card: null }, { type: "object", additionalProperties: false, properties: { card: { type: "json" } } }, false, "json 允许 null"],
    [{ note: null }, { type: "object", additionalProperties: false, properties: { note: { type: "string" } } }, true, "string 遇 null 应报错"],
    [{ ok: 1, extra: 2 }, { type: "object", additionalProperties: false, properties: { ok: { type: "number" } } }, true, "未声明字段应报错"],
    [{ ok: 1, extra: 2 }, { type: "object", additionalProperties: true, properties: { ok: { type: "number" } } }, false, "放宽后允许多余字段"],
  ];
  let selfBad = 0;
  for (const [val, sch, shouldErr, label] of cases) {
    const errs = validateOut(val, sch);
    const gotErr = errs.length > 0;
    if (gotErr !== shouldErr) {
      console.log(`  ✗ ${label}：期望${shouldErr ? "报错" : "通过"}，实际${gotErr ? "报错" : "通过"} ${errs[0] || ""}`);
      selfBad++;
    }
  }
  if (selfBad) process.exit(1);
  console.log(`  ✓ ${cases.length} 个用例全部符合宿主语义`);
}

console.log("\n=== 4.6 output.render 契约（0.5.3 事件回归网）===");
{
  // 宿主 defineTool 会无条件调 output.render(args, value)；工具只写 schema 不写
  // render 时那层包装拿到 undefined，实调必炸 "userRender is not a function"。
  // 注册阶段看不出来（包装是函数），所以这里逐个真调一遍。
  let bad = 0;
  for (const t of registered) {
    const render = t.output?.render;
    if (typeof render !== "function") {
      console.log(`  ✗ ${t.name} 没有 output.render`);
      bad++;
      continue;
    }
    let out;
    try {
      out = render({}, { ok: true, items: [1, 2] });
    } catch (e) {
      console.log(`  ✗ ${t.name} render 抛错: ${e.message}`);
      bad++;
      continue;
    }
    const okShape =
      Array.isArray(out) &&
      out.length > 0 &&
      out.every((b) => b && b.type === "text" && typeof b.text === "string");
    if (!okShape) {
      console.log(`  ✗ ${t.name} render 返回值不是 text block 数组: ${JSON.stringify(out)?.slice(0, 120)}`);
      bad++;
    }
  }
  if (bad) process.exit(1);
  console.log(`  ✓ ${registered.length} 个工具的 render 都返回 text block`);
}

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
  const errs = validateOut(res, tool.output?.schema);
  if (errs.length) {
    console.log("  ✗ output schema 校验失败（宿主会拒收）:");
    errs.slice(0, 5).forEach((e) => console.log("    -", e));
    process.exit(1);
  }
  console.log("  ✓ output schema 白名单校验通过");
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
    const errs = validateOut(res, st.output?.schema);
    if (errs.length) {
      console.log("  ✗ output schema 校验失败（宿主会拒收）:");
      errs.slice(0, 5).forEach((e) => console.log("    -", e));
      process.exit(1);
    }
    console.log("  ✓ output schema 白名单校验通过");
  } catch (e) {
    console.log("  ✗ 搜索失败:", e.message);
  }
}

console.log("\n=== 6.5 默认输出目录（不传 outDir 时落到哪）===");
{
  const ex = registered.find((t) => t.name === "discord_export");
  if (!ex) {
    console.log("  ✗ 没找到 discord_export");
    process.exit(1);
  }
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const fsMod = await import("node:fs");
  try {
    const r = await ex.execute({
      guildId: "1134557553011998840",
      query: "LCP",
      pages: 1,
      title: "load-test-tmp",
    });
    const home = os.default.homedir();
    const downloads = pathMod.default.join(home, "Downloads");
    const expectRoot = fsMod.default.existsSync(downloads) ? downloads : home;
    if (!String(r.path).startsWith(expectRoot)) {
      console.log(`  ✗ 落到了 ${r.path}，期望在 ${expectRoot} 下（宿主 cwd 是安装目录，不能写那里）`);
      process.exit(1);
    }
    console.log("  ✓ 落在", r.path);
    fsMod.default.unlinkSync(r.path);
    console.log("  ✓ 测试文件已清理");
  } catch (e) {
    console.log("  ✗", e.message);
    process.exit(1);
  }
}

console.log("\n=== 7. 参数错误处理 ===");const chTool = registered.find((t) => t.name === "discord_channels");
try {
  await chTool.execute({ guildId: "000000000000000000" });
  console.log("  ✗ 无效 guildId 居然成功了");
} catch (e) {
  console.log("  ✓ 无效 guildId 正确报错:", e.message.slice(0, 60));
}

console.log("\n加载测试结束");
process.exit(0);
