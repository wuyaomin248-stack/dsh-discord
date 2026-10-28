# 安装说明

dsh-discord 是 DSH Desktop 的插件，**29 个只读工具**，用于 Discord 搜索与信息获取。

## 装到哪

```
<DSH 用户目录>/profiles/desktop/node_modules/dsh-discord/
```

Windows 下 `<DSH 用户目录>` 通常是 `%USERPROFILE%\.dsh`。

```bash
git clone https://github.com/wuyaomin248-stack/dsh-discord.git \
  ~/.dsh/profiles/desktop/node_modules/dsh-discord
```

## 注册进 profile

编辑 `profiles/desktop/package.json`，**两处都要加，缺一不加载**：

```json
"dependencies":        { "dsh-discord": "^0.5.5" }
"dsh.profile.bundles": [ "dsh-discord" ]
```

改完重启 DSH Desktop 生效。

## 依赖解析

插件 `import` 了 DSH 内部包 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`
（`@deepseek-ai/cordis` 是可选 peer）。

**正常情况下 DSH 运行时会自己解析，不用管。**

只有一种情况需要手动处理：`profiles/desktop/node_modules/@deepseek-ai/` 下是失效链接
（例如指向了已被删除或移动的安装目录）。这时给插件建 junction 指向真实安装位置：

```bat
cd /d "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-discord"
mkdir node_modules\@deepseek-ai
mklink /J node_modules\@deepseek-ai\dsh-tools    "<DSH 安装目录>\resources\app\node_modules\@deepseek-ai\dsh-tools"
mklink /J node_modules\@deepseek-ai\schemastery  "<DSH 安装目录>\resources\app\node_modules\@deepseek-ai\schemastery"
```

`<DSH 安装目录>` 换成自己的，例如 `<盘符>:\Apps\DSH`。这两个 junction 是**本机路径**，
仓库里不带——带过去没意义。

## 用之前

在 Edge / Chrome / Brave 里登录过 discord.com。插件会自动从浏览器 leveldb 抓 token；
也可以设 `DISCORD_TOKEN` 环境变量指定（多个用逗号或空格分隔）。

## 验证装好了

重启后在 DSH 里调：

```
discord_accounts
```

能列出账号（含 `valid: true`）就说明通了。

## 包里的东西

```
dsh-discord/
├── package.json          插件声明，bundle 入口在 dsh.bundle.patch
├── cordis.patch.yml      加载条目
├── README.md             用法
├── INSTALL.md            本文件
├── CHANGELOG.md          版本记录
├── docs/NOTES.md         实现笔记（坑、判型细节、接口限制）
├── lib/
│   ├── index.js          29 个工具的定义与注册
│   ├── api.js            Discord REST 客户端（限速/重试/代理）
│   ├── token.js          从浏览器 leveldb 抓 token
│   ├── search.js         服务端搜索 + 本地过滤 + 上下文窗口拆解
│   ├── format.js         紧凑化、标记清洗、Markdown 导出
│   ├── download.js       附件下载 + 角色卡判型（PNG tEXt / JSON）
│   ├── cards.js          角色卡抽选（候选收集 / 验证 / 随机）
│   └── plugins.js        插件判型（zip 中央目录 / 单文件脚本）
├── scripts/              check.mjs（离线自检）、link-deps.mjs
└── test/                 unit.mjs 随包提供；其余实测脚本留在仓库
```

## 自测脚本

在仓库开发副本中：

```bash
node scripts/check.mjs    # 离线结构/语法/工具数/敏感信息检查 + unit.mjs
node test/unit.mjs       # 纯函数单元测试，无网络、无 token
node test/load.mjs       # 真实 API 冒烟，需浏览器登录态或 DISCORD_TOKEN + 网络
node test/smoke.mjs      # 抓 token + 打通 API
node test/scenario.mjs   # 真实搜索场景
node test/format.mjs     # 标记清洗 + 频道名补齐
node test/export.mjs     # 导出落盘
node test/plugins.mjs    # 插件判型
node test/archive.mjs    # 整频道归档
node test/tools.mjs      # 查人 / 服务器详情 / 切账号 / 时间过滤
```

安装包只包含 `test/unit.mjs`；其余需要真实账号/网络的脚本仅留在源码仓库。

## 安全

token 等同账号完全控制权。插件只在内存里用，不落盘、不打日志
（`logTokens` 默认关），输出里一律打码成 `MTQyNTQ2…1HDvKA`。
