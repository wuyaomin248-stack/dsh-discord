# dsh-discord

[![checks](https://github.com/wuyaomin248-stack/dsh-discord/actions/workflows/check.yml/badge.svg)](https://github.com/wuyaomin248-stack/dsh-discord/actions/workflows/check.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.5.5-green.svg)](CHANGELOG.md)

DSH Desktop 的 Discord 只读工具集：**29 个工具，全部只读**——不发消息、不改状态、不需要 bot。
凭证直接从浏览器登录态里取，不用手抄 token。

## 安装

```bash
git clone https://github.com/wuyaomin248-stack/dsh-discord.git \
  ~/.dsh/profiles/desktop/node_modules/dsh-discord
```

`profiles/desktop/package.json` 两处都要加（缺一不加载），然后重启 DSH：

```json
"dependencies":        { "dsh-discord": "^0.5.5" }
"dsh.profile.bundles": [ "dsh-discord" ]
```

验证：调一次 `discord_accounts`，能列出 `valid: true` 就通了。
细节（装到哪、依赖 junction、token 来源）见 [INSTALL.md](INSTALL.md)。

## 工具

| 工具 | 用途 |
|---|---|
| `discord_accounts` | 本机能抓到哪些账号（逐个验证） |
| `discord_use` | 多账号切换（进程内生效） |
| `discord_user` | 用户资料：创建时间、徽章、头像、可见的简介/绑定账号/互关服务器 |
| `discord_mentions` | 查看提及当前用户的消息（收件箱） |
| `discord_me_in_guild` | 查看自己在服务器内的昵称、角色、入服时间与禁言状态 |
| `discord_events` | 查看服务器计划活动 |
| `discord_capabilities` | 诊断当前 token 的端点权限（403 与其他错误分开报告） |
| `discord_servers` | 账号所在服务器列表 |
| `discord_guild_info` | 服务器详情：规模、boost、特性、验证等级 |
| `discord_invite` | 解析邀请链接，不加群先看里面是什么 |
| `discord_channels` | 服务器频道结构 |
| `discord_channel_info` | 单个频道详情 |
| `discord_messages` | 读频道消息（翻页 + since/until 过滤） |
| `discord_context` | 某条消息的前后文（`?around=`） |
| `discord_reactions` | 表情回应：汇总 + 谁点了哪个 |
| `discord_pins` | 置顶消息（规则/公告/资料） |
| `discord_search` | 服务端搜索：关键词 + 作者 + 频道 + 时间 + 附件类型 + 置顶 + NSFW |
| `discord_filter` | 本地过滤：正则/关键词翻历史 |
| `discord_search_guild` | 跨频道扫：一个服务器里多处找同一词 |
| `discord_export` | 搜索结果落盘成 Markdown |
| `discord_archive` | 整频道归档：翻页拉全量历史（不靠搜索命中） |
| `discord_download` | 下载附件（带角色卡判型） |
| `discord_card` | 从卡频道随机抽一张验证过的真卡 |
| `discord_plugins` | 列插件频道 / 列论坛帖及其获取方式 |
| `discord_plugin` | 随机抽一个验证过的真插件 |
| `discord_members` | 找成员（403 时降级为从消息作者收集） |
| `discord_roles` | 角色与权限位 |
| `discord_dms` | 私信频道 |
| `discord_threads` | 论坛帖子（单频道或全服扫） |

## 凭证与账号

优先 `DISCORD_TOKEN` 环境变量（多个用逗号或空格分隔）；没设就从浏览器抓。

抓取原理：Discord 网页版把 token 明文放在 `<浏览器 User Data>/<profile>/Local Storage/leveldb`。
浏览器运行时该目录被锁，插件先整目录复制到临时目录再解析，按 `24位ID.6位.27位` 与 `mfa.xxx`
两种形态匹配，且只搜内容里含 `discord` 的文件，避免误匹配。支持 Edge / Chrome / Brave，
Windows / macOS / Linux 路径都覆盖。缓存 token 全部 401 时会自动重扫一次。

## 常用姿势

```
discord_search(guildId, query="X")                       # 这服务器里哪提到过 X
discord_search(guildId, query="X", since="2026-10-19")   # 最近一周
discord_search(guildId, authorId="<id>")                 # 某人都说过什么
discord_search(guildId, query="", has="link")            # 所有带链接的消息
discord_search(guildId, query="", pinned=true)            # 只看置顶消息
discord_search(guildId, query="关键词", includeNsfw=true)  # 包含 NSFW 频道
discord_mentions(limit=10)                                  # 最近提及当前账号
discord_filter(channel="<频道ID>", pattern="https?://github\\S+", regex=true)
discord_context(channelId, messageId, limit=6)            # 这条消息前后在聊什么
discord_archive(channel="<帖子ID>", maxMessages=500)      # 整帖存下来
discord_card(keyword="古风")                              # 抽一张真卡
```

`discord_export` 生成按频道分组的 Markdown，带作者、时间、embed 引用、附件链接；
`discord_download` 下载附件，重名自动加序号，返回里带 CDN 的 `expiresAt`（约 24 小时）。

## 输出做了什么

原始 Discord JSON 直接看很吵，`compactMessage` 统一处理：

- **标记转可读**：`<@1400…>` → `@类脑娘`（能从 mentions 查到名字的）、`<:shy:id>` → `:shy:`、
  `<t:1761408000:R>` → ISO 时间、`</help:id>` → `/help`
- **embed 不丢**：标题、URL、摘要都保留，里面的标记同样清洗
- **交互组件可读**：按钮标签/链接、下拉菜单占位符会并入消息结果
- **命中标记**：服务端搜索返回「每组一个上下文窗口」，真正命中那条带 `hit: true`，插件只取命中项 + 2 条上下文
- **频道名补齐**：帖子（type 11/12）不在服务器频道列表里，逐个 `GET /channels/{id}` 捞名字并缓存

## 判型：角色卡 vs 插件

`discord_download` / `discord_card` / `discord_plugin` 会判断文件是不是「真东西」——Discord 上
PNG 大多只是封面图，脚本文件名也不可信。

| | 角色卡 | 插件 |
|---|---|---|
| 标志 | PNG 的 `tEXt` chunk 或 JSON 里的 `chara` / `ccv3` | zip 里有 `manifest.json` + `index.js`，或 JSON 带 `name` + `content` |
| 真货比例 | 有附件的约 10% | 有附件的约 60% |
| 名字来源 | 数据块内的 `name` | 文件内部的 `name`（文件名常是 `-.json`） |

返回 `{ ok, kind, name, spec, ... }`，`ok: false` 时 `why` 说明原因。
发布形态、判型细节、实测数据见 [docs/NOTES.md](docs/NOTES.md)。

## 已知限制

- **只读**。要发消息得另写，不在范围内。
- **`discord_members` 拿不到完整名单**：`guilds/{id}/members` 与 `members/search` 都要
  `GUILD_MEMBERS` 权限，普通 token 一律 403；工具降级成「从最近消息作者里收集」+ 服务器总人数。
- **论坛活跃帖取不到**：`guilds/{id}/threads/active` 只有 bot 能用，`discord_threads` 的
  `onlyActive` 常得到 0 条——接口限制，不是过滤写错。
- 无权限频道 403 会被 `discord_search_guild` 记进 `forbiddenChannels` 并继续扫，不中断。
- 服务端搜索每页 25 条，`offset` 翻页；实测 `includeNsfw=true` 时 `total_results` 会显著高于普通搜索（约 6220 万），但 offset 0/25/50 都返回了有效分页，故总数只作参考；`discord_archive` 每页 100 条串行，
  `maxMessages` 默认 1000，大频道按需调小。
- token 会因 IP 变动或改密码失效，浏览器重登即可，插件下次自动抓到新的。

## 安全

token 等同账号完全控制权。插件只在内存里用，不落盘、不打日志（`logTokens` 默认关），
输出里一律打码成 `MTQyNTQ2…1HDvKA`。

## 开发

```
lib/            index.js（29 个工具定义）+ api/token/search/format/download/cards/plugins
scripts/        check.mjs（离线自检，CI 跑的就是它）、link-deps.mjs（链接 @deepseek-ai/*）
test/           unit.mjs（纯函数单测）、load.mjs（加载校验）以及各类实测脚本
docs/NOTES.md   实现笔记：踩过的坑、判型细节、接口限制
```

```bash
node scripts/link-deps.mjs   # 一次性：把 @deepseek-ai/* 链进来（自动探测，探不到给路径）
npm run check                # 离线自检：结构/语法/工具数/敏感信息/文档一致性/单测
npm test                     # = npm run check
npm run test:unit            # 纯函数单元测试（不联网、无需 token）
node test/load.mjs           # 注册/输出契约 + 少量真实 API 冒烟（需登录 token 和网络）
```

其余真实 API 测试脚本也用 `node test/<名称>.mjs` 运行（如 `smoke`、`scenario`、`format`、
`export`、`plugins`、`archive`、`tools`）；它们只在仓库开发树内，npm 包不包含这些 live 脚本。

改完推之前跑 `npm run check`——它不联网、不要 token。CI 在 ubuntu + windows × node 20/22 上各跑一次。

## License

MIT · 变更见 [CHANGELOG.md](CHANGELOG.md)
