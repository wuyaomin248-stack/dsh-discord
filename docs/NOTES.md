# 实现笔记

给改代码的人看的东西：踩过的坑、判型细节、接口限制。用法看 [README](../README.md)。

## 两种搜索怎么选

- `discord_search` 走 Discord 服务端索引：快、能跨频道、支持时间/作者/附件类型筛选。
  依赖服务器开了搜索索引，且无权访问的频道会被静默跳过。
- `discord_filter` / `discord_search_guild` 本地翻消息：慢，但任何有读权限的频道都能用，
  还支持正则。
- 服务端搜不到时用本地那套。

## 角色卡判型

- PNG 卡的数据在 `tEXt` chunk 里，结构是 `keyword + \0 + base64(JSON)`，keyword 为
  `chara`（V1/V2）或 `ccv3`（V3）。**不是独立的 chunk 类型**——以为 chunk 叫 `ccv3` 就永远解不出名字。
- 大量 PNG 只是封面图，没有数据块。实测某个卡频道 40 个候选里只有 4 个是真卡（10%）。
- JSON 卡可能被命名成 `MVU.json`，但内容是完整卡——看字段，不看文件名。

```json
{ "ok": true, "kind": "chara", "name": "完美世界沙盒",
  "spec": "chara_card_v3", "firstMesLen": 1249, "size": 2084994 }
```

## 插件判型

插件和角色卡是完全不同的一套：zip 里有 `manifest.json` + `index.js`；单文件形态是 `.json`
带 `name` + `content`（content 是 JS 源码）。

实测 25 个插件帖的发布形态：

```
14/25   正文放 GitHub/Gitee 链接，没有附件
 2/25   回复里挂 zip
12/25   首帖只有截图和描述
```

所以 `discord_plugin` 同时扫**正文链接**和**回复附件**；没附件但有仓库链接的以 `kind: "repo"`
返回（`allowRepoOnly` 控制是否允许）。文件名不可信：很多脚本叫 `-.json`、`---CDN.json`，
真名在文件内部的 `name` 字段。

```json
{ "ok": true, "kind": "script", "name": "工具调用拦截-可排除脚本",
  "contentLen": 57629, "scriptType": "script" }
```

## 踩过的坑

- **DSH schema 编译器要求每个 object 显式声明 `additionalProperties: true|false`**，包括
  `items: { type: "object" }` 和 `properties: { x: { type: "object" } }` 这种嵌套的。
  漏一层 `defineTool` 直接抛 `JsonSchemaError`。
- **`defineTool()` 会无条件包一层 `render`**：只声明 `output.schema` 不声明 `output.render`，
  注册能过、实调必炸（`userRender is not a function`）。插件里统一补了默认渲染。
- **cordis 的 Context 是 Proxy**：给 `ctx` 赋值或 `Object.create(ctx)` 后挂属性会抛
  `cannot set property "tools" in multiple fibers`，整个 `apply` 失败、一个工具都注册不上。
- **帖子（type 11/12）不在 `guilds/{id}/channels` 里**：只查那张表，搜出来的消息全是无名频道 ID。
- **表情名可以含点号和下划线**（排版技巧会用 `<:letter_a:id>`），清洗正则用 `\w+` 会漏，要用 `[^:<>]+`。
- **embed 里的文字也带 Discord 标记**，只洗 `content` 会留残留。
- **`GET /channels/{cid}/messages/{mid}` 只对 bot 开放**，用户 token 调它一律 403；
  取单条要用 `?around=<id>` 再挑出来。

## 普通 token 拿不到的端点

| 端点 | 限制 |
|---|---|
| `guilds/{id}/threads/active` | 只有 bot |
| `channels/{id}/messages/{mid}` | 只有 bot（改用 `?around=`） |
| `users/{id}` | 未授权 |
| 论坛频道里的 `messages/search` | 缺权限 |
| `guilds/{id}/members`、`members/search` | 需要 `GUILD_MEMBERS` |

## 服务端搜索的返回形状

每页 25 条，`offset` 翻页，`hasMore` 判断还有没有。返回的是「每组一个上下文窗口」，
真正命中的那条带 `hit: true`，插件只取命中项并附 2 条上下文。
