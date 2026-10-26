# 安装说明

dsh-discord 是 DSH Desktop 的插件，**25 个只读工具**，用于 Discord 搜索与信息获取。

## 装到哪

```
<DSH 用户目录>/profiles/desktop/node_modules/dsh-discord/
```

Windows 下 `<DSH 用户目录>` 通常是 `%USERPROFILE%\.dsh`。

把本仓库内容整个放进该目录，或直接：

```bash
git clone https://github.com/wuyaomin248-stack/dsh-discord.git \
  ~/.dsh/profiles/desktop/node_modules/dsh-discord
```

## 注册进 profile

编辑 `profiles/desktop/package.json`，**两处都要加，缺一不加载**：

**1. dependencies 里加一行**

```json
"dsh-discord": "0.5.0",
```

**2. dsh.profile.bundles 数组里加一项**

```json
"dsh-discord",
```

改完重启 DSH Desktop 生效。

## 依赖解析

插件 `import` 了三个 DSH 内部包：

- `@deepseek-ai/dsh-tools`
- `@deepseek-ai/schemastery`
- `@deepseek-ai/cordis`（peer，可选）

**正常情况下 DSH 运行时会自己解析，不用管。**

只有一种情况需要手动处理：`profiles/desktop/node_modules/@deepseek-ai/` 下是失效链接
（例如指向了已被删除或移动的安装目录）。这时给插件建 junction 指向真实安装位置：

```bat
cd /d "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-discord"
mkdir node_modules\@deepseek-ai
mklink /J node_modules\@deepseek-ai\dsh-tools    "<DSH 安装目录>\resources\app\node_modules\@deepseek-ai\dsh-tools"
mklink /J node_modules\@deepseek-ai\schemastery  "<DSH 安装目录>\resources\app\node_modules\@deepseek-ai\schemastery"
```

`<DSH 安装目录>` 换成你自己的，例如 `D:\Apps\DSH\resources\app`。

这两个 junction 是**本机路径**，仓库里不带——带过去没意义。

## 用之前

在 Edge / Chrome / Brave 里登录过 discord.com。插件会自动从浏览器
Level Storage 抓 token；也可以设 `DISCORD_TOKEN` 环境变量指定。

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
├── README.md             完整用法
├── INSTALL.md            本文件
├── CHANGELOG.md          版本记录
├── lib/
│   ├── index.js          25 个工具的定义与注册
│   ├── api.js            Discord REST 客户端（限速/重试/代理）
│   ├── token.js          从浏览器 leveldb 抓 token
│   ├── search.js         服务端搜索 + 本地过滤 + 上下文窗口拆解
│   ├── format.js         紧凑化、标记清洗、Markdown 导出
│   ├── download.js       附件下载 + 角色卡判型（PNG tEXt / JSON）
│   ├── cards.js          角色卡抽选（候选收集 / 验证 / 随机）
│   └── plugins.js        插件判型（zip 中央目录 / 单文件脚本）
└── *.mjs                 自测脚本，可单独跑
```

## 自测脚本

装好依赖解析后可以单独跑（不经过 DSH）：

```bash
node smoke.mjs             # 抓 token + 打通 API
node scenario.mjs          # 搜索场景
node load-test.mjs         # 插件加载 + 工具注册（不联网）
node verify-improve.mjs    # 标记清洗 + 频道名补齐
node verify-export.mjs     # 导出落盘
node test-plugin-tools.mjs # 插件判型工具
node test-archive.mjs      # 整频道归档
node test-050-tools.mjs    # 0.5.0 新工具（查人/服务器详情/切账号/时间过滤）
```

`load-test.mjs` 不需要网络也不需要 token，可用来确认 25 个工具全部注册成功。

## 安全

token 等同账号完全控制权。插件只在内存里用，不落盘、不打日志
（`logTokens` 默认关），输出里一律打码成 `MTQyNTQ2…1HDvKA`。
