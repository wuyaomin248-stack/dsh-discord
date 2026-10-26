# Changelog

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
