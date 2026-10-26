# Changelog

## 0.5.3 — 2026-10-27

**修 25 个工具全部实调失败：`output.render failed: userRender is not a function`**

- 症状：工具能出现在列表里、`execute` 也真跑完（Discord 请求都发出去了），但宿主拿结果时统一报
  `tool "<name>" returned invalid output: output.render failed: userRender is not a function`。
- 根因：宿主 `dsh-tools` 的 `defineTool()` 会先抓 `const userRender = options.output.render`，
  再无条件包一层 `render(args, value) { return userRender(args, value) }`。
  本插件 25 个工具只声明了 `output.schema`、没声明 `output.render`，包装层拿到 `undefined`，
  调用即 TypeError。注册阶段查不出来——包装函数本身是 `function`，所以 `register()` 的白名单检查放行，
  只有实调才炸。
- 修法：插件自己的 `defineTool()` 包装里补默认渲染（`defaultRender`），结构化结果转成
  `[{ type: "text", text: JSON.stringify(value, null, 1) }]`，一处改动覆盖全部 25 个工具。
- 回归网：`load-test.mjs` 新增第 4.6 节，逐个真调每个工具的 `output.render({}, 样例值)`，
  断言返回非空 text block 数组——只检查「有没有定义 render」不够，必须真调一次。

**`discord_reactions` 改用 around 取消息（原来对用户 token 必挂）**

- `GET /channels/{cid}/messages/{mid}` 只对 bot token 开放，浏览器抓来的用户 token 调它一律
  `403 只有机器人可使用此端点`。`api.getMessage()` 改为 `?around=<id>&limit=5` 取周边再挑出目标，
  找不到时抛 404 而不是静默返回别的消息。

**`fetchStarter()` 换成 `after=0`（原来定位不到大帖主帖）**

- 旧实现从最新消息往前翻，`maxPages=6` 只覆盖 600 条；1767 条的预设帖只能翻到中间，
  取回来的「主帖」完全不在开头，`discord_card` / `discord_plugin` 因此抽不到附件。
- 改为 `getMessages({ limit: 100, after: "0" })` 一次取最早一批（返回仍按新→旧），
  取数组最后一个即主帖。实测 RUAN 预设帖精确命中 `1540275527687077989` 与其 `RUAN_1.4.json`。

**重启后工具全消失（`unknown tool "discord_user"`）——补三处**

- `exports` 缺 `./cordis.patch.yml`：宿主按包名解析 bundle 的 patch 时会抛
  `ERR_PACKAGE_PATH_NOT_EXPORTED`（同机 `dsh-remote` 导出了这个子路径，能正常挂载）。已补该子路径。
- 注册壳：调用点从 `ctx.tools.register(...)` 换成局部 `register(...)`（内部 try/catch，单个工具失败不再让全部工具一起消失），
  `apply` 结束时用 `ctx.logger` 打一行「dsh-discord 就绪：N 个工具已注册」（或失败清单）。
  **不要给 ctx 赋值、也不要 `Object.create(ctx)` 后挂属性**：cordis 的 Context 是 Proxy，会抛
  `cannot set property "tools" in multiple fibers`，整个 `apply` 直接失败、一个工具都注册不上。
  这个坑真实发生过一次（2026-10-27）：一开始日志里只有 `unknown tool`，加了壳才看见真实报错。
- profile 依赖从精确 `0.5.2` 改成 `^0.5.3`：本机唯一一个「声明版本不满足已装版本」的包。

## 0.5.2 — 2026-10-26

0.5.1 之后继续排查同类问题，按宿主校验器的实际语义逐个对了一遍。

**修 null 输出（同 0.5.1 的第二波，抽不到东西时才触发）**

宿主 `dsh-tools` 的校验器里，`type: "object"` 遇 `null` 直接报
`must be an object`（`null` 不算 plain record），`type: "string"` 遇 `null` 报
`must be a string`。而这些字段在「没抽到 / 空频道」时正是 `null`：

- `discord_card`：`card`、`picked` → `json`
- `discord_plugin`：`plugin`、`picked` → `json`
- `discord_threads`：`note`（单频道无更多时是 null）→ `json`
- `discord_archive`：`firstMessageAt`、`lastMessageAt`（空频道）→ `json`

`load-test.mjs` 的 `validateOut()` 补上 null 语义，并加一节校验器自检
（5 个用例，覆盖 object/string 遇 null、白名单拒收、放宽放行），防止校验网本身失灵。

**默认输出目录不再用 `process.cwd()`**

`discord_export` / `discord_archive` / `discord_download` 不传 `dir`/`outDir` 时，
之前落到 `process.cwd()`——在 DSH 宿主里那是安装目录（app.asar 旁边），
写进去可能没权限、用户也找不到。改为 `~/Downloads`，没有就落 home。

**代理挂掉自动旁路**

本机代理（FlClashCore 之类）重启期间，所有请求直接失败、整个插件跟着不可用。
现在识别出「代理连不上」（`proxy` / `ECONNREFUSED 127.0.0.1` 特征）就立刻切直连
重试 60 秒，之后自动再试代理——代理恢复后无需人工干预。

## 0.5.1 — 2026-10-26

修一个 0.5.0 上线后才暴露的致命 bug：**几乎所有工具在宿主里实调都会失败**。

- 症状：重启后调 `discord_user` 报
  `tool "discord_user" returned invalid output: "value.source" is not a declared property (additionalProperties: false)`。
- 根因：`envelope()` 给每个返回附加 `source` 字段，但各工具的 output schema 是
  `additionalProperties: false` 白名单，`source` 从未声明；嵌套层（`messages` 的
  items、`accounts` 的 items）同样是白名单且几乎没声明任何字段。之前 load-test
  直接调 `execute()` 绕过了宿主校验，所以一直没暴露。
- 修法：包装 `defineTool`，注册前递归把 output schema 里所有
  `type: "object" && additionalProperties === false` 的节点放宽为 `true`。
  顶层、`properties` 嵌套、`items` 嵌套一次覆盖。字段级类型声明仍然生效。
- `load-test.mjs` 补 `validateOut()`：复刻宿主的白名单校验语义，对
  `discord_servers` 与 `discord_search` 的实调结果各校验一次，schema 不合规直接
  退出码 1。这是本次事故的回归网——下次不用等重启才发现。

## 0.5.0 — 2026-10-26

20 → 25 个工具，全部只读。

**新增 5 个工具**

- `discord_use`：多账号切换。进程内换当前账号（用户名/显示名/ID 子串匹配），
  之后所有工具用被切换的账号；不带参数列出全部账号及验证状态。
- `discord_user`：查单个用户资料。账号创建时间（snowflake 解出）、徽章
  （public_flags 位解读：Staff/合作伙伴/HypeSquad/早期支持者等）、头像/横幅链接。
  传 `me` 或留空查当前账号，`<@123>` 提及形式自动清洗。
- `discord_guild_info`：服务器详情。成员数/在线数、boost 等级与数量、
  features 中文解读（社区/合作伙伴/可发现/自动管理等）、验证等级、
  NSFW 分级、vanity 链接；`channels: true` 附各类型频道统计。
- `discord_invite`：解析邀请链接。不加入就能看服务器名、成员数、指向频道、
  过期时间、邀请人。支持 `discord.gg/xxx`、`discord.com/invite/xxx`、裸码。
- `discord_reactions`：消息表情回应。不传 emoji 返回全部表情及数量汇总；
  传 emoji 返回点了这个表情的用户列表（自定义表情自动转成 `name:id` 形式）。

**增强**

- `discord_messages` 支持 `since` / `until` 按时间过滤（snowflake 边界换算），
  「看昨天这个频道聊了什么」不再需要先找消息 ID。
- `compactMessage` 输出补四类内容，之前这些消息看起来像空的：
  贴纸（`sticker_items` 名字）、投票（问题 + 选项 + 当前票数）、
  转发快照（`message_snapshots` 展开 300 字）、非默认消息类型
  （join/pin/boost/系统提示，标 `type` 字段）。
- `primary()` 支持偏好账号：有偏好时按 token 逐个验证直到匹配，
  匹配不到退回第一个有效账号；无偏好时行为与之前完全一致。

**修复**

- `discord_pins` 的 output schema 之前是空 `properties: {}`，补全。

## 0.4.1 — 2026-10-26

工程化补齐，工具行为无变化。

- **`scripts/check.mjs`**：离线自检。不联网、不要 token、不需要 `@deepseek-ai/*`，
  检查 package.json 字段、必需文件、全部 js/mjs 语法、工具数量与命名、敏感信息、
  README 工具表与代码是否一致。之前这些全靠手工核对，漏过一次（INSTALL.md 写「14 个工具」而代码是 20 个）。
- **`scripts/link-deps.mjs`**：自动探测 DSH 安装目录并把 `@deepseek-ai/*` 链到插件自己的
  `node_modules/`。之前 clone 下来直接 `node load-test.mjs` 会报
  `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`，得手工敲三条 mklink。
- **`.github/workflows/check.yml`**：CI 在 ubuntu 和 windows 各跑一次离线自检。
- **package.json** 补 `repository` / `bugs` / `homepage` / `scripts`（10 条），
  `files` 从逐个列举改成目录（`lib/`、`scripts/`），之前新增 `cards.js`、`plugins.js`
  时忘记加进 files，npm 打包会漏。
- **README** 加状态徽章和快速开始，本地调试段落改成从 clone 开始（之前默认你已经在安装目录里）。

## 0.4.0 — 2026-10-26

新增 `discord_archive`：翻页拉整个频道 / 整个帖子的全量历史，存 Markdown。
与 `discord_export` 的区别是**不依赖搜索命中**——导出走的是搜索结果，归档走的是时间线。
实测 300 条 / 3 页正确截断，时间范围过滤准确，条数上限精确。

修掉两个实测发现的真 bug：

- **`discord_members` 之前完全不可用**。`guilds/{id}/members` 与 `members/search`
  都要 `GUILD_MEMBERS` 权限，普通用户 token 一律 403。改为三级降级：
  原生接口 → 从消息作者收集 → 服务器总人数（`guild?with_counts` 始终可用）。
  实测拿到 10 人 + 40.8 万成员统计。
- **`discord_threads` 的活跃模式必然失败**。原来调的是 `guilds/{id}/threads/active`，
  bot 专用端点。改为全服扫论坛频道走 `channels/{forum}/threads/archived/public`。
  实测扫 5 个论坛拿到 20 帖，无权限论坛正确跳过。

另确认归档接口返回的几乎全是 `archived=true`，`onlyActive` 常得 0 条——
这是接口硬限制，已在参数说明和 `note` 里写明。

工具数 19 → 20。

## 0.3.0 — 2026-10-26

新增 `discord_plugins` 与 `discord_plugin`，逻辑与抽卡类似但判型完全不同：
插件 zip 里要有 `manifest.json` / `index.js`，单文件脚本要有 `name` + `content` 字段。
会同时扫正文里的 GitHub / Gitee 链接和回复里的附件，因为插件常常没有直接附件。

实测 25 个插件帖：14 个只放仓库链接、2 个回复挂 zip、12 个只有截图。
附件扩展名分布 `.json: 23`、`.zip: 3`、`.txt: 1`——插件主流形态是单文件脚本 JSON，不是 zip。

工具数 17 → 19。

## 0.2.0 — 2026-10-26

新增 `discord_download`（附件下载 + 角色卡判型）、`discord_context`（读消息前后文）、
`discord_card`（从卡频道随机抽验证过的真卡）。

判型依据：角色卡数据在 PNG 的 **`tEXt` chunk** 里，结构是 `keyword + \0 + base64(JSON)`，
keyword 为 `chara` 或 `ccv3`——不是独立的 chunk 类型。之前按 chunk 类型找，名字永远是 null。

实测某卡频道 40 个候选里只有 4 个是真卡（10%），所以 `maxCheck` 默认提到 40，
抽不到时返回 `reasons` 直方图和 `hint`，而不是空结果。

工具数 14 → 17。

## 0.1.0 — 2026-10-26

首个版本。14 个只读工具：账号 / 服务器 / 频道 / 消息 / 搜索 / 过滤 / 跨频道扫 /
导出 / 置顶 / 成员 / 角色 / 私信 / 论坛帖。

token 从 Edge / Chrome / Brave 的 leveldb 自动抓取，支持 `DISCORD_TOKEN` 覆盖。
