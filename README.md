# dsh-discord

[![check](https://github.com/wuyaomin248-stack/dsh-discord/actions/workflows/check.yml/badge.svg)](https://github.com/wuyaomin248-stack/dsh-discord/actions/workflows/check.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.4.1-green.svg)](CHANGELOG.md)

Discord 只读搜索与信息获取。凭证自动从浏览器 Local Storage 取，不用手抄 token。

**20 个工具，全部只读**——不发消息、不改状态、不需要 bot。

```
npm i -g 无；直接 clone 到 profile 的 node_modules 即可
git clone https://github.com/wuyaomin248-stack/dsh-discord.git
```

## 快速开始

```bash
# 1. 放到 DSH profile
git clone https://github.com/wuyaomin248-stack/dsh-discord.git \
  ~/.dsh/profiles/desktop/node_modules/dsh-discord

# 2. 注册（profiles/desktop/package.json 两处）
#    dependencies:          "dsh-discord": "0.4.1"
#    dsh.profile.bundles:   "dsh-discord"

# 3. 重启 DSH，然后
discord_accounts        # 能列出 valid: true 就通了
```

前提：浏览器里登录过 discord.com。

## 干什么

20 个工具，全部只读——不发消息、不改状态：

| 工具 | 用途 |
|---|---|
| `discord_accounts` | 看本机能抓到哪些账号（自动验证） |
| `discord_servers` | 账号所在的服务器列表 |
| `discord_channels` | 服务器下的频道结构 |
| `discord_channel_info` | 单个频道详情 |
| `discord_messages` | 读频道消息（可翻页） |
| `discord_context` | **读某条消息前后文**（`?around=`） |
| `discord_pins` | 置顶消息（规则/公告/资料） |
| `discord_search` | **服务端搜索**：关键词 + 作者 + 频道 + 时间 + 附件类型 |
| `discord_filter` | **本地过滤**：正则/关键词翻历史 |
| `discord_search_guild` | **跨频道扫**：一个服务器里多处找同一词 |
| `discord_export` | **落盘**：搜索结果存成 Markdown |
| `discord_archive` | **整频道归档**：翻页拉全量历史存 Markdown（不靠搜索命中） |
| `discord_download` | **下载附件**：带角色卡判型，CDN 链接会过期必须现在下 |
| `discord_card` | **抽卡**：从卡频道随机抽一张验证过的真卡 |
| `discord_plugins` | **找插件**：列插件频道 / 列出论坛帖子及其获取方式 |
| `discord_plugin` | **抽插件**：随机抽一个验证过的真插件 |
| `discord_members` | 找成员（403 时降级为从消息作者收集） |
| `discord_roles` | 角色与权限位 |
| `discord_dms` | 私信频道 |
| `discord_threads` | 论坛帖子（单频道或全服扫） |

## 输出做了哪些处理

原始 Discord 数据直接给人看很吵，插件在 `compactMessage` 里统一处理：

- **标记转可读**：`<@1400045042349113394>` → `@类脑娘`（能从消息的 mentions 里查到名字的），`<:shy:xxx>` → `:shy:`，`<t:1761408000:R>` → ISO 时间，`</help:xxx>` → `/help`
- **embed 不丢**：链接预览的标题、URL、摘要都保留——信息量常比正文大。embed 里的标记同样清洗。
- **命中标记**：服务端搜索返回的是「每组一个上下文窗口」，真正命中的那条带 `hit: true`，插件只取命中项，附带 2 条上下文。
- **频道名补齐**：帖子（type 11/12）不在服务器频道列表里，插件会逐个 `GET /channels/{id}` 捞名字并缓存。不补的话搜出来全是无名 ID。

## 凭证从哪来

优先 `DISCORD_TOKEN` 环境变量；没设就从浏览器抓。

抓取原理：Discord 网页版把 token 明文存在 localStorage，位置是
`<浏览器 User Data>/<profile>/Local Storage/leveldb`。插件把整个 leveldb
目录复制到临时目录再解析（浏览器运行时原文件被锁，直接读会拿到半截数据），
在里面按 `24位ID.6位.27位` 和 `mfa.xxx` 两种形态匹配，且只搜内容里出现
`discord` 字样的文件，避免误匹配。

支持的浏览器：Edge / Chrome / Brave（Windows、macOS、Linux 路径都覆盖）。

**token 失效自动恢复**：如果缓存的 token 全部返回 401，插件会清空缓存重新扫
浏览器一次——通常你在浏览器里已经重新登录过了。

**前提**：在浏览器里登录过 discord.com。

## 用哪个账号

`discord_accounts` 会列出所有抓到的 token 并逐个验证，看 `valid: true`
和 `user.username`。其余工具自动选第一个可用的。

想指定账号就设环境变量，它会覆盖浏览器抓取：

```
set DISCORD_TOKEN=你的token
```

多个 token 用逗号或空格分隔。

## 典型用法

**「这个服务器里哪里提到过 X」**
```
discord_search(guildId, query="X")
```

**「最近一周关于 X 的讨论」**
```
discord_search(guildId, query="X", since="2026-10-19")
```

**「这个人在这个服务器说过什么」**
```
discord_members(guildId, query="名字")   # 先拿到 ID
discord_search(guildId, authorId="<id>", query="关键词")
```

**「找所有带链接的消息」**
```
discord_search(guildId, query="", has="link")
```

**「论坛区有哪些帖子」**
```
discord_threads(guildId)              # 活跃
discord_threads(channelId="<论坛频道>")  # 已归档
```

**「这个频道里符合某正则的内容」**
```
discord_filter(channel="<频道ID>", pattern="https?://github\\.com/\\S+", regex=true)
```

**「把搜到的存下来」**
```
discord_export(guildId, query="Kimi", pages=2, outDir="E:\\资料")
```
生成按频道分组的 Markdown，带作者、时间、embed 引用、附件链接。

**「这条消息前后在聊什么」**
```
discord_context(channelId, messageId, limit=6)
```

**「附件下下来」**
```
discord_download(urls=["https://cdn.discordapp.com/..."], dir="E:\\资料")
```
Discord CDN 链接约 24 小时失效（`ex=` 参数是到期时间戳），
工具会在返回里带 `expiresAt`。重名文件自动加序号，不覆盖。

**「随机抽一张角色卡」**
```
discord_card()                          # 从「每日新卡」抽
discord_card(keyword="古风")            # 只抽卡名含关键词的
```
返回下载链接 + 卡名 + 格式 + 作者标签。**只从验证过的真卡里抽**。

## 角色卡判型

`discord_download` 和 `discord_card` 都会判型，因为 Discord 上的坑很实在：

- **PNG 卡的数据在 `tEXt` chunk 里**，结构是 `keyword + \0 + base64(JSON)`，
  keyword 为 `chara`（V1/V2）或 `ccv3`（V3）。不是独立的 chunk 类型。
- **大量 PNG 只是封面图**，没有数据块。实测某个卡频道 40 个候选里只有 4 个是真卡（10%）。
- **JSON 卡可能被命名成 `MVU.json`**，但内容是完整卡——要看字段不看文件名。

判型返回：

```json
{ "ok": true, "kind": "chara", "name": "完美世界沙盒",
  "spec": "chara_card_v3", "firstMesLen": 1249, "size": 2084994 }
```

`ok: false` 时 `why` 会说明原因（"图片里没有 chara/ccv3 数据（多半是封面图）"）。

## 插件判型

插件跟角色卡是完全不同的一套，别看错：

| | 角色卡 | 插件 |
|---|---|---|
| 标志 | PNG/JSON 里的 `chara`/`ccv3` 数据块 | zip 里有 `manifest.json` + `index.js` |
| 单文件形态 | V3 JSON（`spec: chara_card_v3`） | `.json` 带 `name` + `content`（content 是 JS 源码） |
| 比例 | 有附件的约 10% 是真卡 | 有附件的约 60% 是真插件 |

**插件的发布形态比卡散得多**（实测 25 个插件帖）：

```
14/25   正文放 GitHub/Gitee 链接，没有附件
 2/25   回复里挂 zip
12/25   首帖只有截图和描述
```

所以 `discord_plugin` 会同时扫**正文链接**和**回复附件**。没附件但有仓库链接的，
会以 `kind: "repo"` 返回（`allowRepoOnly` 控制是否允许）。

判型返回：

```json
{ "ok": true, "kind": "script", "name": "工具调用拦截-可排除脚本",
  "contentLen": 57629, "scriptType": "script" }
```

**注意文件名不可信**：Discord 上很多脚本叫 `-.json`、`---CDN.json`，
真正的名字在文件内部的 `name` 字段。插件优先用内部名字。

`discord_plugins` 还能先摸底：

```
discord_plugins(guildId="...")        # 列出疑似插件频道
discord_plugins(forumId="...", scan=true)  # 列出帖子 + 每个有没有 zip/仓库
```

## 两种搜索怎么选

- `discord_search` 走 Discord 服务端索引，快、能跨频道、支持时间/作者筛选。
  但依赖服务器开了搜索索引，且无权访问的频道会被静默跳过。
- `discord_filter` / `discord_search_guild` 本地翻消息，慢，但任何有读权限的
  频道都能用，还支持正则。

服务端搜不到时用本地那套。

## 安装位置

```
~/.dsh/profiles/desktop/node_modules/dsh-discord/
```

已在 profile 的 `package.json` 注册：
- `dependencies` 加了 `dsh-discord`
- `dsh.profile.bundles` 加了 `dsh-discord`

改完需重启 DSH 才加载。

## 本地调试

```bash
git clone https://github.com/wuyaomin248-stack/dsh-discord.git
cd dsh-discord

node scripts/link-deps.mjs   # 链上 @deepseek-ai/*（只需一次）
node scripts/check.mjs       # 离线自检：结构/语法/工具数/敏感信息
```

`link-deps.mjs` 会自动探测 DSH 安装目录，探不到就手动指定：

```bash
node scripts/link-deps.mjs "D:/Apps/DSH/resources/app"
```

之后可以跑需要网络和 token 的实测脚本：

```bash
node load-test.mjs         # 插件加载 + 20 工具注册（最快，先跑这个）
node smoke.mjs             # 抓 token + 打通 API
node scenario.mjs          # 真实搜索场景
node verify-improve.mjs    # 标记清洗 + 频道名补齐
node verify-export.mjs     # 导出落盘
node test-plugin-tools.mjs # 插件判型
node test-archive.mjs      # 整频道归档
```

也可以用 npm scripts：

```bash
npm run check          # = node scripts/check.mjs
npm run test:load
npm run test:smoke
```

`node_modules/@deepseek-ai/` 下的链接指向 DSH 安装目录，仅供这些脚本
本地运行；DSH 运行时由宿主自己解析，不依赖它。

## 贡献

改完代码推之前跑一遍 `npm run check`——它不联网、不要 token，检查：
package.json 字段、必需文件、全部 js/mjs 语法、工具数量与命名、敏感信息、
README 工具表与代码是否一致。

CI 在两个平台各跑一次（ubuntu + windows），验证路径分支都正常。

## 踩过的坑

- **DSH schema 编译器要求每个 object 显式声明 `additionalProperties: true|false`**，包括 `items: { type: "object" }` 和 `properties: { x: { type: "object" } }` 这种嵌套的。漏一层 `defineTool` 直接抛 `JsonSchemaError`。
- **帖子（type 11/12）不在 `guilds/{id}/channels` 里**。只查那张表，搜出来的消息全是无名频道 ID。要么逐个 `GET /channels/{id}` 捞，要么从传送门拿 thread id。
- **表情名可以含点号和下划线**（Discord 的排版技巧会用 `<:letter_a:id>`），清洗正则用 `\w+` 会漏；要用 `[^:<>]+`。
- **embed 里的文字也带 Discord 标记**，只洗 `content` 会留下残留。
- **角色卡数据在 PNG 的 `tEXt` chunk 里**，不是独立 chunk。以为 chunk 类型叫 `ccv3` 就永远解不出名字。
- **普通用户 token 拿不到这些端点**：`guilds/{id}/threads/active`（只有 bot）、`channels/{id}/messages/{mid}` 单条精确取（只有 bot）、`users/{id}`（未授权）、论坛频道里的 `messages/search`（缺少权限）。

## 已知限制

- **只读**。要发消息得另写，当前范围外。
- **`discord_members` 拿不到完整名单**：`guilds/{id}/members` 和 `members/search` 都要 `GUILD_MEMBERS` 权限，普通 token 一律 403。工具会降级成「从最近消息作者里收集」，只能拿到发过言的人，另外附带服务器总人数。要完整名单必须 bot token。
- **论坛的活跃帖取不到**：`guilds/{id}/threads/active` 只有 bot 能用。`channels/{forum}/threads/archived/public` 能取到帖子，但返回的几乎都是 `archived=true`。所以 `discord_threads` 的 `onlyActive` 常会得到 0 条——这是接口限制，不是过滤写错。
- 无权限的频道返回 403，`discord_search_guild` 会把它列进 `forbiddenChannels`
  并继续扫其它频道，不中断。
- 服务端搜索每页 25 条，用 `offset` 翻页，`hasMore` 判断还有没有。
- `discord_archive` 每页 100 条串行翻，`maxMessages` 默认 1000；拉很大的频道会慢，按需调小。
- token 会因 IP 变动或改密码失效，失效后重登浏览器即可，插件下次会抓到新的。

## 安全

token 等同于账号完全控制权。插件只在内存里用，不落盘、不打日志
（`logTokens` 默认关）。输出里出现的 token 一律打码成 `MTQyNTQ2…1HDvKA`。
