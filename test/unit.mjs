import assert from "node:assert/strict";
import {
  cleanContent,
  compactMessage,
  compactChannel,
  compactGuild,
  compactUser,
  channelTypeName,
  groupByChannel,
  toMarkdown,
} from "../lib/format.js";
import {
  snowflakeForDate,
  dateFromSnowflake,
  searchPageInfo,
  explicateSearchResults,
  buildSearchQuery,
} from "../lib/search.js";

console.log("=== 1. cleanContent 标记清洗 ===");
{
  const raw = "<@12345> 欢迎加入 <#999>，身份组是 <@&777>，发送 <:shy:888>，时间是 <t:1700000000:R>，命令是 </help:111>";
  const msg = { mentions: [{ id: "12345", username: "user_a", global_name: "UserA" }] };
  const cleaned = cleanContent(raw, msg);
  assert.equal(cleaned.includes("@UserA"), true, "用户提及未转换为 global_name");
  assert.equal(cleaned.includes("#999"), true, "频道未清洗");
  assert.equal(cleaned.includes("@role:777"), true, "身份组未清洗");
  assert.equal(cleaned.includes(":shy:"), true, "自定义表情未清洗");
  assert.equal(cleaned.includes("/help"), true, "命令未清洗");
  assert.equal(cleaned.includes("2023-11-14"), true, "时间戳未转换为 ISO 时间");
  console.log("  ✓ cleanContent 各类标记转换正常");
}

console.log("=== 2. compactMessage 紧凑消息与组件提取 ===");
{
  const mockMsg = {
    id: "1134557553011998840",
    channel_id: "10001",
    author: { id: "20001", username: "tester", global_name: "TesterBot", bot: true },
    content: "请点击下方按钮",
    hit: true,
    attachments: [{ filename: "card.png", size: 1024, content_type: "image/png", url: "https://cdn.example.com/card.png" }],
    embeds: [{ type: "rich", title: "测试标题", description: "测试描述", url: "https://example.com" }],
    reactions: [{ emoji: { name: "🔥" }, count: 5 }],
    sticker_items: [{ name: "好耶" }],
    components: [
      {
        type: 1,
        components: [
          { type: 2, label: "确认", url: "https://example.com/ok" },
          { type: 3, placeholder: "选择一个角色" },
        ],
      },
    ],
  };

  const compacted = compactMessage(mockMsg, { channelName: "测试频道" });
  assert.equal(compacted.channel, "测试频道");
  assert.equal(compacted.author, "TesterBot");
  assert.equal(compacted.bot, true);
  assert.equal(compacted.hit, true);
  assert.equal(compacted.attachments?.length, 1);
  assert.equal(compacted.embeds?.length, 1);
  assert.equal(compacted.reactions?.[0], "🔥×5");
  assert.equal(compacted.stickers?.[0], "好耶");
  assert.equal(compacted.components?.length, 2);
  assert.equal(compacted.components[0].includes("确认"), true);
  assert.equal(compacted.components[1].includes("选择一个角色"), true);
  console.log("  ✓ compactMessage 完整提取附件、Embed、Reactions、Stickers 与 Components");
}

console.log("=== 3. snowflake 时间戳双向转换 ===");
{
  const date = new Date("2024-01-01T00:00:00.000Z");
  const sf = snowflakeForDate(date);
  assert.equal(typeof sf, "string");
  const reverted = dateFromSnowflake(sf);
  assert.equal(reverted.toISOString(), date.toISOString());
  console.log("  ✓ snowflakeForDate <-> dateFromSnowflake 转换精确无损");
}

console.log("=== 4. searchPageInfo 与 explicateSearchResults ===");
{
  const mockSearch = {
    total_results: 42,
    documents_indexed: 100,
    messages: [
      [
        { id: "101", author: { username: "a" }, content: "上下文前" },
        { id: "102", author: { username: "b" }, content: "命中项", hit: true },
        { id: "103", author: { username: "c" }, content: "上下文后" },
      ],
    ],
  };
  const pageInfo = searchPageInfo(mockSearch);
  assert.equal(pageInfo.total, 42);
  assert.equal(pageInfo.documentsIndexed, 100);

  const groups = explicateSearchResults(mockSearch);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].message.id, "102");
  assert.equal(groups[0].hit, true);
  assert.equal(groups[0].context.length, 2);
  console.log("  ✓ searchPageInfo 与 explicateSearchResults 命中分离与上下文解析正确");
}

console.log("=== 5. buildSearchQuery 过滤参数映射 ===");
{
  assert.deepEqual(buildSearchQuery({}), { sort: "timestamp", offset: 0 });
  assert.deepEqual(
    buildSearchQuery({
      content: "needle",
      authorId: "42",
      channelId: "17",
      minId: "100",
      maxId: "200",
      has: "image",
      pinned: false,
      includeNsfw: true,
      offset: 25,
    }),
    {
      sort: "timestamp",
      offset: 25,
      content: "needle",
      author_id: "42",
      channel_id: "17",
      min_id: "100",
      max_id: "200",
      has: "image",
      pinned: false,
      include_nsfw: true,
    }
  );
  console.log("  ✓ 搜索参数正确映射，pinned=false 不丢失");
}

console.log("=== 6. groupByChannel 与 toMarkdown ===");
{
  const msgs = [
    { channel: "公告区", author: "Alice", content: "公告1", time: "2024-01-01T10:00:00.000Z" },
    { channel: "闲聊区", author: "Bob", content: "聊天1", time: "2024-01-01T10:05:00.000Z" },
    { channel: "公告区", author: "Charlie", content: "公告2", time: "2024-01-01T10:10:00.000Z" },
  ];
  const grouped = groupByChannel(msgs);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].channel, "公告区");
  assert.equal(grouped[0].count, 2);

  const md = toMarkdown(msgs, { title: "测试导出" });
  assert.equal(md.includes("# 测试导出"), true);
  assert.equal(md.includes("## 公告区"), true);
  assert.equal(md.includes("## 闲聊区"), true);
  assert.equal(md.includes("Alice"), true);
  console.log("  ✓ groupByChannel 分组排序与 toMarkdown 输出正常");
}

console.log("=== 6. compact helper 边界 ===");
{
  assert.equal(compactChannel({ id: "1", name: "general", type: 0 }).type, "text");
  assert.equal(compactGuild({ id: "2", name: "guild", approximate_member_count: 10 }).members, 10);
  assert.equal(compactUser({ id: "3", username: "user", verified: false }).verified, false);
  assert.equal(channelTypeName(15), "forum");
  console.log("  ✓ compactChannel / compactGuild / compactUser / channelTypeName 正常");
}

console.log("\n全部单元测试通过！");
