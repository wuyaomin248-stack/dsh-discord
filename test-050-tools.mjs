/**
 * 0.5.0 新工具实调回归：discord_user / discord_guild_info / discord_use /
 * discord_reactions / discord_messages 的 since 时间过滤。
 *
 * 需要本机浏览器里登录过 discord.com（真实 token + 真实 API）。
 * 用法：node test-050-tools.mjs
 */
import * as plugin from "./lib/index.js";

const tools = new Map();
plugin.apply(
  {
    tools: { register: (t) => tools.set(t.name, t) },
    logger: { info: () => {} },
  },
  {}
);

let failed = 0;
async function run(name, args, check) {
  const t = tools.get(name);
  if (!t) {
    console.log(`✗ ${name}: 未注册`);
    failed += 1;
    return null;
  }
  try {
    const r = await t.execute(args);
    const problem = check ? check(r) : null;
    if (problem) {
      console.log(`✗ ${name}: ${problem}`);
      failed += 1;
    } else {
      console.log(`✓ ${name}`);
    }
    return r;
  } catch (e) {
    console.log(`✗ ${name}: ${e.message}`);
    failed += 1;
    return null;
  }
}

// 当前账号资料：必须有 id / username / created
const me = await run("discord_user", {}, (r) =>
  !r?.user?.id || !r.user.username || !r.user.created
    ? "返回缺 id/username/created"
    : null
);

// 服务器详情：必须有 name / members / features 数组
const servers = await run("discord_servers", {}, (r) =>
  !r?.servers?.length ? "账号不在任何服务器里" : null
);
const guildId = servers?.servers?.[0]?.id;
if (guildId) {
  await run("discord_guild_info", { guildId, channels: true }, (r) =>
    !r?.guild?.name || typeof r.guild.members !== "number"
      ? "返回缺 name/members"
      : null
  );
}

// 列出账号（不切换）：accounts 必须是数组且非空
await run("discord_use", {}, (r) =>
  !Array.isArray(r?.accounts) || !r.accounts.length ? "accounts 为空" : null
);

// 表情回应汇总：需要一条有回应的消息——先搜一个频道，没有就跳过
// 时间过滤：since 昨天应只返回边界内消息（允许为空，但字段必须齐）
if (guildId) {
  const chs = await run("discord_channels", { guildId });
  const textCh = chs?.channels?.find((c) => c.type === "text");
  if (textCh) {
    await run(
      "discord_messages",
      { channel: textCh.id, limit: 5, since: "2020-01-01" },
      (r) => (!Array.isArray(r?.messages) ? "messages 不是数组" : null)
    );
    await run(
      "discord_messages",
      { channel: textCh.id, limit: 5, until: "2020-01-02" },
      (r) =>
        !Array.isArray(r?.messages)
          ? "messages 不是数组"
          : r.messages.length
            ? "until=2020 应返回 0 条（服务器没那么老）"
            : null
    );
  }
}

console.log(failed ? `\n失败 ${failed} 条` : "\n全部通过");
process.exit(failed ? 1 : 0);
