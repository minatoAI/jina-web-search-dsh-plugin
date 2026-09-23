[English](README.en.md) | **简体中文**

# dsh-jina

DeepSeek Harness 的 [Jina AI](https://jina.ai/) 插件（bundle）：把 jina-cli 的全部 API 能力以模型工具的形式装进 dsh，并在 Web 的 **Plugins** 侧边栏页（`dsh-jina` bundle 卡片）提供配置表单来设置 API key 与**本地代理地址**；旧版 harness 上则回落到 **设置 → 插件 → 配置** 的同名卡片。

## 更新日志

> 此处仅展示最新版本，完整版本历史见 [change-log.md](./change-log.md)。

### 0.8.1（2026-09-23）

- **fix** **修复新版 harness 上「阅读工具选项」与两个保存按钮全部变灰、无法修改**（用户实测截图）：dsh `601d6761e4` 删除了 `settings.register(ns, schema)`，设置命名空间改为 **Loader 组合条目 id**，插件须导出 schemastery 形态的 `Config`（字段节点带 `meta.volatile`）并接收 `apply(ctx, config)`。旧代码调用已不存在的 `sctx.settings.register`，异常被 try/catch 吞掉 → `jina-tools` 从未出现在 `settings.describe()` 里 → 卡片 `phase = 'unavailable'` → 所有控件 `disabled`。**不是 CSS / 权限 / 只读 profile 问题**，同一根因也让配置根本存不进去。
- **fix** **保存即时生效**：字段是跨副本安全的 volatile 引用（`Symbol.for('cosmokit.volatile.write')`），保存时 harness 只改写引用，`fiber.config` 身份不变、不重挂载，插件每次操作重新读取——与 API key 同一条契约。
- **fix** 逐字段 `meta.volatile`（**不能**整段 volatile，否则 `strip()` 会丢掉文档里未声明的键）；`validate` 同步返回纯对象且对 `undefined` / 脏值容错（`describe()` 是整个 Plugins 页共用的，抛错会波及所有卡片）；`toJSON()` 每次返回新节点（`plainSchema()` 会 `delete meta.volatile`）。
- **change** 宿主半身不再 `inject(['settings'])`；`/api/dsh-jina/primer` 的 `settingsError` 改为 `settingsLive` 健康检查。
- **test** 四个测试文件全部迁移到新 seam，新增「保存后下一次调用即生效」端到端回归；全套 104 例（103 通过 / 1 例按需跳过）。

### 0.8.0（2026-09-18）

- **feat** **`jina_read` 新增 OCR 开关（jina-ocr-v1）**：`ocr: true` 或在卡片里设为默认后，改走官方 3.4B 文档解析模型，一次过把扫描件 / 图片型 PDF / 复杂表格与公式转成 Markdown（表格出 HTML、公式出 LaTeX），多页文档可用 `page` 指定单页。约 **40× token**，且**必须有 API key**（官方对匿名请求直接 401），因此没检测到 key 时**不发请求**、直接给可操作提示。
- **feat** **每次读取固定发送三个零副作用参数**：`X-Preset: agent`（官方为 AI agent 预调的预设，**只填充未显式设置的选项**）、`X-Base: final`（用跳转后的 URL 解析相对链接）、`X-Timeout: 120`（与客户端 120s 上限对齐的慢页面兜底）。
- **feat** **选择器组默认开启 + 空结果自动回退**：默认发保守的正文选择器与噪声排除列表，新增 `targetSelector` / `waitForSelector` / `removeSelector` / `noCache` 调用参数；选择器不命中导致结果过短时**自动去掉选择器组重试**，不会返回空页。
- **feat** **图片策略回到官方默认 `all`**（可选 `alt` / `none`），不再硬编码 `none`；设置卡片新增「阅读工具选项」区块（OCR / 图片策略 / alt 生成 / 选择器组 / 选择器覆盖），与 `proxyUrl` 同走一条 revision 栅栏写入路径。
- **fix** `X-With-Generated-Alt` 改为**默认关闭**：需 key、与 OCR 互斥，而且**带 key 的请求才计费**——默认开启会把"匿名免费读取"静默变成"计费读取"。
- **fix** `createSettingsSchema()` 此前只保留 `proxyUrl`，新增字段会被静默丢弃；现保留全部已知字段，并新增 `toolSettingsOf()` 把"未设置"解析为默认值（设置文档仍只存偏离默认值的部分）。
- **fix** **必填参数不再被静默转成字符串 `"undefined"`**：`ctx.tools.register` 运行期不校验参数，模型把键名写错（如用内置 `web_search` 的 `queries` 代替本插件的 `query`）时 `String(args.query)` 会把它变成搜索词 `undefined`，Jina 返回 MDN 的 `undefined` 词条——**`isError: false`、看起来像真结果**。现对 `jina_web_search` / `jina_search_arxiv` / `jina_search_ssrn` / `jina_expand` / `jina_rerank` / `jina_embed` / `jina_classify` / `jina_pdf` 的必填参数前置校验并**直接抛错**（`isError: true`），报错点名工具、参数与疑似笔误，且不发任何请求。
- **change** `jina_read` 固定用 `Accept: application/json`，解包成带 `Title` / `URL Source` / `[Usage: …]` 的 markdown；不可解析的响应原文返回。
- **test** 新增 `test/reader-headers.test.js`（14 例，解码网络 helper 的 stdin 逐条断言真实发出的请求头）与 `test/tool-args.test.js`（9 例，以实测现场那次 `{queries:[…],num:6}` 错误调用为第一条断言，含"被拒调用零请求"与合法路径不回归）；`client-render.test.js` 与 `client-bundle.test.js` 增加选项控件的渲染与接线断言。完整说明见 [change-log.md](./change-log.md)。

## 功能

安装后所有会话（所有 agent preset）都会获得 12 个 `jina_*` 工具：

| 工具 | 对应 jina-cli 命令 | 说明 |
| --- | --- | --- |
| `jina_web_search` | `jina search` | 通用网页搜索（默认 web 域；images / blog 域，支持时间过滤与地区/语言提示） |
| `jina_search_arxiv` | `jina search --arxiv` | arXiv 预印本检索（CS / ML / 数学 / 物理等，返回 arxiv.org 官方论文直链） |
| `jina_search_ssrn` | `jina search --ssrn` | SSRN 论文检索（经济 / 金融 / 法律 / 管理等社会科学，返回 papers.ssrn.com 直链） |
| `jina_read` | `jina read` | 把网页读成干净的 markdown；支持 OCR（jina-ocr-v1）、正文选择器与噪声过滤（见下节） |
| `jina_screenshot` | `jina screenshot` | 网页截图，返回托管图片 URL（支持整页截图） |
| `jina_datetime` | `jina datetime` | 推测网页的发布/更新时间 |
| `jina_expand` | `jina expand` | 把搜索词扩展成一组相关查询 |
| `jina_embed` | `jina embed` | 文本向量化（默认 jina-embeddings-v5-text-small） |
| `jina_rerank` | `jina rerank` | 按相关性重排文档（默认 jina-reranker-v3.5） |
| `jina_classify` | `jina classify` | 文本分类 |
| `jina_pdf` | `jina pdf` | 从 PDF 提取图表/公式（支持 arXiv ID） |
| `jina_primer` | `jina primer` | 获取当前上下文：主机时钟（ISO 时间/unix/时区/UTC 偏移）、网络事实（公网 IP 与位置，尽力而为）与 Jina 账户状态（身份/余额） |

## 阅读工具选项（`jina_read`）

卡片里的「阅读工具选项」区块（也可直接改 `settings.yaml` 的 `jina-tools` 段）决定 `jina_read` 的默认行为；每个选项都能被同名调用参数**单次覆盖**。

| 选项 | 字段 | 默认 | 作用与代价 |
| --- | --- | --- | --- |
| OCR 文档解析 | `useOcr` | 关 | 走 `X-Respond-With: jina-ocr-v1`：官方 3.4B 文档解析模型，一次过把扫描件 / 图片型 PDF / 复杂表格与公式转成 Markdown（表格出 HTML、公式出 LaTeX）。**约 40× token**，且**必须有 API key**——官方对匿名请求返回 401，本插件因此直接不发请求并给出提示。多页文档用调用参数 `page` 指定单页 |
| 图片保留策略 | `imagePolicy` | `all` | `all` = 官方默认；`alt` = 只保留 alt 文本（省 token）；`none` = 不保留图片 |
| 生成图片 alt 文本 | `autoAltText` | 关 | `X-With-Generated-Alt`：为缺说明的图片生成描述。**需 API key**（匿名 401），且**与 OCR 互斥**（指定 `X-Respond-With` 时该功能不生效）；又因为**带 key 的请求会计费**，默认关闭，需要时显式打开 |
| 选择器组 | `useSelectors` | 开 | 默认发保守的 `X-Target-Selector`（只含 `article` / `main` / `[role="main"]` / `.markdown-body` 等正文容器）与 `X-Remove-Selector`（页眉页脚、导航、cookie 横幅、广告、侧栏、评论等）。命中不到时**自动回退整页重试**，不会返回空 |
| 正文 / 排除选择器 | `targetSelector` / `removeSelector` | 空 = 内置列表 | 覆盖内置选择器（站点结构特殊、默认列表误伤时用） |

每次 `jina_read` 还会固定发送三个零副作用参数：`X-Preset: agent`（官方为 AI agent 预调的预设；官方文档明确 preset **只填充调用方未显式设置的选项**，所以不会覆盖任何显式参数）、`X-Base: final`（用重定向后的最终 URL 解析相对链接）、`X-Timeout: 120`（与客户端自己的 120s 上限对齐——若发官方的上限 180，客户端会先超时并报自己的错误，多出来的耐心是浪费的；要改就两边一起改）。

调用级参数：`ocr`、`page`、`targetSelector`、`waitForSelector`、`removeSelector`、`noCache`，以及原有的 `links` / `images` / `json` / `apiKey`。

> 关于"为什么默认这样"：这三项是官方 Reader API 里**最坏情况不损失什么**的参数；而 OCR 与 alt 生成需要 key、会计费或与其它参数互斥，所以一律默认关闭。`X-Remove-Overlay` / `X-Detach-Invisibles` 这两个未在官方参数面板文档化的隐藏参数**没有**被默认启用（后者官方明确要求 browser 引擎且禁用缓存）。

## 效果实测（与内置 web_search 交叉对比）

为了让模型**不用记住参数**就能用对检索域，学术检索单独拆成了 `jina_search_arxiv` / `jina_search_ssrn` 两个专用工具（对应 `jina search --arxiv` / `--ssrn`）——工具名即用途，模型看到用户要论文会直接调用它们。以下为 2026-08-13 在同机真实网络环境（VPN 系统代理）下的抽样对比：同一查询分别调用本插件与 dsh 内置 `web_search`，人工核对结果。

| 场景 | 本插件（dsh-jina） | 内置 web_search | 结论 |
| --- | --- | --- | --- |
| 学术检索（arXiv） | `jina_search_arxiv`「retrieval augmented generation survey」→ **9/9 全部为 arxiv.org 官方直链**：2312.10997（RAG 经典综述）、2506.00054、2410.12837、2501.09136（Agentic RAG）、2405.07437、2504.08748 等，篇篇主题契合、摘要准确 | 同查询返回 arXiv **镜像站**（ezproxy.obspm.fr、ar5iv、sinoxiv.napstic.cn）与 BibTeX 链接，官方直链缺失 | ✅ jina 胜：官方直链 + 精准召回 |
| 学术检索（SSRN） | `jina_search_ssrn`「large language models financial markets」→ **9/9 全部为 papers.ssrn.com 原文**：市场情绪预测、LLM 模拟交易、AI 羊群效应、投资者分歧等，契合度极高 | 无 SSRN 专用检索能力 | ✅ jina 胜：独占 SSRN 域 |
| 中文新闻 / 社区 / 官方源 | `jina_web_search` 官方源（政府 / 公司官网）置顶，可加 `time` 过滤时效 | 同查询结果相关，但官方源不置顶 | ✅ jina 优：权威源优先 + 时效过滤 |
| 泛学术检索（未指定域） | 默认 web 域对 Springer / IEEE / ACL 等覆盖面一般（学术检索请改用上面的专用工具） | Springer / IEEE / ACL 覆盖面广 | ✅ web_search 优：泛学术检索用它 |

**结论与分工用法**：学术论文 → `jina_search_arxiv` / `jina_search_ssrn`；中文时效新闻 → `jina_web_search`（+ `time`）；泛学术 / 工程文档 → 内置 `web_search`。两者互补，覆盖全部检索场景。

> 注：上表为单轮抽样对比（非严格 benchmark），结果受当天网络与查询选择影响；两个工具链均真实可用，结论供选型参考。

## 安装

仓库地址：https://github.com/minatoAI/jina-web-search-dsh-plugin

插件按 [bundle](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md) 方式分发，用 `dsh plugin` 安装进 profile（从源码 checkout 运行时用 `pnpm dsh` 代替 `dsh`）：


> 从 GitHub 安装（本项目无 build 脚本，无需 allowBuilds 授权）

```sh
dsh plugin --profile web add github:minatoAI/jina-web-search-dsh-plugin
```

> 更稳妥：固定到某个 commit，避免后续推送改变实际安装到的代码

```sh
dsh plugin --profile web add github:minatoAI/jina-web-search-dsh-plugin#<commit-sha>
```

> 或本地文件夹安装（开发调试用）

```sh
dsh plugin --profile web add ./jina-dsh-plugin
```

安装完成后**重启** dsh（新 bundle 在下次启动时生效）：

```sh
dsh --profile web
```

然后打开 Web 界面 → 设置 → **插件** → **配置** 选项卡 → 展开 **Jina Tools** 卡片 → 粘贴 API key → 保存。免费 key 在 https://jina.ai/ 获取。

同一张卡片里还有 **本地代理（可选）**：如果你的代理软件只监听本地端口（没有开启系统代理，也没有设置 `HTTP_PROXY` 环境变量），把它的地址填进去即可，例如 `http://127.0.0.1:7897`（可省略 `http://`）→ 保存，下一次工具调用立即生效。代理软件换端口时改这里即可，不需要重启 dsh。

卡片中的 **API key / 连接检测** 区域会实时显示当前 key 的身份（Jina 账号）与余额（credits）、标注 key 的来源（本页保存 / key 文件 / 匿名配额），并显示**本次检测实际使用的代理地址与来源**；点击「刷新」重新检测（保存/清除 key 或代理后也会自动重检）。该数据由主机端插件通过 `/api/dsh-jina/primer` 路由提供（与 `jina_primer` 工具同一接口），**key 明文永不离开主机**；代理地址是明文配置，会显示在页面上。

## API key 解析顺序

每次工具调用按以下顺序找 key（任一命中即用）：

1. 工具调用参数 `apiKey`
2. 设置页保存的 key（credential 引用 `JINA_API_KEY`，由 dsh 凭据存储持久化，如 `~/.dsh/.credentials.yaml`）
3. 会话工作区的 `jina-api-key.txt`
4. dsh 主目录（`$DSH_HOME`，默认 `~/.dsh`）下的 `jina-api-key.txt`

设置页保存新 key 后立即生效（无需重启，每次调用即时解析）；HTTP 401 时也会自动重读文件并重试一次。凭据值只通过 `credentials.set` 上行，任何读取接口都不会回传明文。同时支持在页面上一键清除。

## 本地代理（本地网络代理软件）

Jina 域名被直连网络屏蔽，需要代理。插件的代理解析顺序（每次调用即时解析，改完即生效）：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 设置卡片「本地代理」 | `jina-tools` 命名空间的 `proxyUrl` 字段，最推荐的手动方式 |
| 2 | 环境变量 `JINA_PROXY_URL` | 没有挂载 settings 提供方的 profile（如 headless）也能用 |
| 3 | Windows 系统代理 | 从 WinINET 注册表自动发现（`ProxyEnable=1` 时），传输失败会重新发现一次，VPN 换端口可自愈 |
| 4 | 启动环境变量 | harness 解析的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`，由 `subprocess` 自动带给网络 helper |

规则与注意事项：

- **只支持 `http://` 和 `https://` 代理**。网络 helper 是 `node -e` + 全局 `fetch`，靠 `NODE_USE_ENV_PROXY` 识别代理；`socks://` 等 scheme 会让 Node 启动即退出，因此这类地址会被拒绝并在页面/错误信息里说明。
- **本地代理软件只监听端口、未设为系统代理时**（WinINET `ProxyEnable=0x0`），优先级 3 发现不到它——这正是要在卡片里手填地址的场景。
- 手动填写的地址**优先于**自动发现；传输失败时插件不会偷偷改用自动发现的代理，而是把当前使用的地址写进错误信息，便于确认端口是否写错。
- 地址可以省略协议头（`127.0.0.1:7897` 等价于 `http://127.0.0.1:7897`），可以带账号密码（`http://user:pass@127.0.0.1:7897`），路径/查询串会被忽略。
- 代理地址会明文保存在 dsh 的设置文档（`settings.yaml` 的 `jina-tools` 段）并可被 Web 页面读回；**只在本机受信环境使用**，不要把带凭据的地址提交到公开仓库。
- 「清除」后回到自动检测（优先级 3 → 4）。

## 卸载

```sh
dsh plugin --profile web remove dsh-jina
```

## 仓库结构

```
jina-dsh-plugin/
├── package.json       # manifest: "dsh": { "bundle": {"patch": ...}, "client": {"platform": "web"} }; 浏览器半身经 exports["./client"] 指向 ui/client.js
├── cordis.patch.yml   # 组合层：单个双面孔行 dsh-jina（宿主工具 + 浏览器卡片；行名 = 精确包名是 client-modules 扫描的硬条件）
├── index.js           # 主机插件：12 个工具（含 jina_search_arxiv / jina_search_ssrn 专用学术检索）+ 网络传输 + JINA_API_KEY 凭据解析 + jina-tools 代理与阅读策略
├── proxy.js           # 纯函数模块：代理地址规范化 / 优先级 / 阅读策略默认值与设置 schema（零依赖，可单测）
├── primer.js          # 纯函数模块：jina_primer 的解析 / 格式化逻辑（零依赖，可单测）
├── test/
│   ├── primer.test.js        # jina_primer 单元测试（node --test 自动发现）
│   ├── proxy.test.js         # 代理策略单元测试
│   ├── plugin-proxy.test.js  # mock 宿主的代理集成测试（含可选实时代理用例）
│   ├── reader-headers.test.js# jina_read 请求头契约测试（解码 helper 的 stdin，断言真实发出的头）
│   ├── client-bundle.test.js # 浏览器 bundle 契约测试（语法 + 注册 id + settings 通道 + 选项接线）
│   ├── client-render.test.js # 在 VM 中真实渲染两种视图（抓作用域/绑定类缺陷）
│   └── tools.test.js         # jina_web_search 模型可见契约测试（TDD）
├── ui/
│   ├── package.json   # 子包 manifest（exports["./client"]；dsh.client 主声明已在根包，此处仅保持子包完整）
│   ├── index.js       # 空主机半身（保留历史子包结构；组合层不再引用）
│   └── client.js      # 预构建浏览器 bundle：Plugins 页的 "Jina Tools" 卡片（API key + 本地代理 + 阅读选项）
├── change-log.md      # 完整版本历史（简体中文）
├── change-log.en.md   # 完整版本历史（English）
├── README.md          # 简体中文说明（本文件）
└── README.en.md       # English README
```

## 开发说明

- 主机插件只依赖 Node 内置模块与 dsh 主机服务（`fs`、`subprocess`、`tools`、`credentials`、`webServer`），无第三方 npm 依赖；凭据走 dsh 原生的 credential seam（引用 `JINA_API_KEY`），配置走插件自己的 `jina-tools` 设置命名空间（`proxyUrl` 代理地址 + `useOcr` / `imagePolicy` / `autoAltText` / `useSelectors` / 三个选择器覆盖等阅读策略），任何 profile 组合都可以直接使用。
- **设置通道的契约（dsh 0.1.4 起）**：`settings.register()` 已被删除，**设置命名空间就是 Loader/profile 组合条目的 id**——本插件在 `cordis.patch.yml` 里插入的行 id 正是 `jina-tools`，所以卡片里的 `NS` 与之一致。插件通过 `index.js` 的 `export const Config = createSettingsSchema()`（`proxy.js`，零依赖手写节点）声明可编辑字段：每个字段节点带 `meta.volatile: true`，`'~standard': { version: 1, vendor: 'schemastery', validate }` 是 harness 解析配置的唯一入口（`resolveConfig()` 要求**同步**返回纯对象；`vendor` 必须是 `'schemastery'`，否则每次保存都会退化成整插件重挂载）。`validate()` 为每个字段生成一个**跨副本安全的 volatile 引用**（`Symbol.for('cosmokit.volatile.write')`），harness 保存时只把新值写进这些引用，`apply(ctx, config)` 拿到的对象身份不变、插件不重挂载；插件在**每次操作**里用 `settingsSnapshot(config)` 重新读取（`toolSettingsOf()` 负责把"未设置"归一成默认值），因此保存与 API key 一样**立即生效、无需重启**。`/api/dsh-jina/primer` 的 `settingsLive` 就是这个契约的健康检查。
- 客户端 bundle 直接提交（`ui/client.js`），无构建步骤，git 安装开箱即用。改 UI 后直接改该文件并重启即可。bundle 顶层 `window.__ModuleLoader__.load` 的注册 id **必须等于图行 id（精确包名 `dsh-jina`）**——模块系统只按图行 id 匹配注册（`/client` 后缀除外），注册在别的键上（如旧行名 `dsh-jina/ui`）会报 `loaded without registering "dsh-jina"` 并导致整页 `Failed to load plugins`。卡片注册进 Web 设置包声明的 `settings.plugin.item` 插槽（设置 → 插件 → 配置），这是第三方插件配置的标准位置。
- **`remote.<ns>` 的注入铁律**：gateway `$mount` 时会把每个 Remote 命名空间注册成**独立 cordis 服务**，所以客户端插件读取 `remote.<ns>`（如 `remote.credentials`、`remote.settings`）之前，必须在自己的 `inject` 里声明该服务名——只声明 `'remote'` 是不够的，属性访问本身就会抛 `cannot get property "remote.settings" without inject`，而错误冒到 `settings.plugin.item` 的 slot 边界会让**整张卡片消失**（0.6.0 的回归，现已由 `test/client-bundle.test.js` 固化）。本插件的 `inject = ['slots','remote','remote.credentials','remote.settings']`。读取处仍然包一层 try/catch：服务缺失时降级为提示，不让 slot 崩溃。
- key 通过凭据 Remote 命名空间管理（`credentials.describe/set/unset`，变更事件 `credentials/reference-updated` 由 `remote` 服务转发）；代理字段走 `settings` Remote 命名空间（`remote.settings.describe/mutate`，写入按读到的 `revision` 设栅；外部编辑由转发事件 `settings/document-updated` 触发热重读）。
- 组合层遵循 dsh 约定：单个双面孔行 `dsh-jina` 同时携带宿主半身与浏览器半身。浏览器半身由**根 manifest** 的 `dsh.client`（platform: web，图边注入 `@deepseek-ai/dsh-api-remotes`）与 `exports["./client"]` 声明，host 的 client-modules 服务扫描时按行名（精确包名）定位根 manifest 并接入 Web boot graph。注意 client-modules 扫描只接受精确包名行：子路径行（如 `dsh-jina/ui`）永远不会被扫描为客户端行——浏览器半身必须声明在根包。

## 测试

纯函数逻辑（代理策略、primer 解析/格式化等）使用 Node 内置测试运行器，零依赖：

```sh
npm test   # 等价于 node --test（自动发现 test/*.test.js）
```

- `test/proxy.test.js`、`test/primer.test.js`、`test/tools.test.js`：纯函数与模型可见契约。
- `test/reader-headers.test.js`：用假 Cordis 上下文驱动主机半身，**解码网络 helper 的 stdin**，逐条断言 `jina_read` 真实发出的 Reader 请求头——固定三项（`X-Preset: agent` / `X-Base: final` / `X-Timeout: 120`）、图片策略、选择器组与"空结果自动重试"、OCR 开关与 `X-Page`、无 key 时零请求、alt 生成的 opt-in / 需 key / 与 OCR 互斥、JSON 信封解包与 usage、不可解析响应原文兜底，以及设置 schema 的字段声明（8 个字段都带 `meta.volatile`）、`validate` 的容错面与"保存后下一次调用即生效"。
- `test/plugin-proxy.test.js`：用假 Cordis 上下文驱动主机半身，断言 `Config` 导出的 volatile 契约、代理优先级、**网络 helper 实际收到的环境变量**、错误文案与 `/api/dsh-jina/primer` 负载（含 `settingsLive`），以及"卡片保存的代理地址在下一次调用即生效、且不再探测注册表"。其中带 `JINA_LIVE_PROXY=1` 的用例会真实 spawn helper 打通一次 Jina 请求（干净环境 + 手填代理，用来证明是手填地址而非残留环境变量在起作用）：

  ```powershell
  $env:JINA_LIVE_PROXY='1'; $env:JINA_LIVE_PROXY_URL='http://127.0.0.1:7897'; npm test
  ```

  在无法 spawn 子进程的沙箱里该用例会自动跳过并说明原因。
- `test/client-bundle.test.js`：解析预构建的 `ui/client.js` 并固化注册 id、`jina-tools` key、settings 通道与 revision 栅栏——bundle 没有构建步骤，语法错误只能在运行时暴露。
