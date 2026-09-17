[English](README.en.md) | **简体中文**

# dsh-jina

DeepSeek Harness 的 [Jina AI](https://jina.ai/) 插件（bundle）：把 jina-cli 的全部 API 能力以模型工具的形式装进 dsh，并在 Web 的 **Plugins** 侧边栏页（`dsh-jina` bundle 卡片）提供配置表单来设置 API key 与**本地代理地址**；旧版 harness 上则回落到 **设置 → 插件 → 配置** 的同名卡片。

## 更新日志

> 此处仅展示最新版本，完整版本历史见 [change-log.md](./change-log.md)。

### 0.7.1（2026-09-18）

- **fix** 修复 0.7.0 引入的配置表单崩溃导致 **API key 与本地代理输入框在 Plugins 页整块消失**（实测控制台：`ReferenceError: input is not defined` → `slot entry crashed in 'plugins.bundle.config'`）：0.7.0 把表单函数 `body()` 提到了 factory 作用域，而它读取的全是 `JinaCard` 组件内部的 state 与 handler（`input` / `onInput` / `onSave` / `configured` / `proxyBlock` …）。修复：把 `body()` 移回组件内部；旧的折叠卡片展开时崩溃的问题一并恢复。
- **test** 新增 `test/client-render.test.js`：在 VM 中真实执行浏览器 bundle、按 cordis 契约挂载插件、以 React 的方式渲染 `summary` / `page` 两种视图（含旧卡片展开态），断言两个输入框都被渲染——原有的契约测试只做源码正则，测不到这类作用域缺陷。

### 0.7.0（2026-09-17）

- **compat** 适配新版 dsh：插件配置插槽由 `settings.plugin.item`（keyed，Settings → Plugins → Configure）改为 `plugins.bundle.config`（keyed by bundle 包名，随 Plugins 页的 dsh-jina bundle 卡片渲染，宿主索取 `summary` / `page` 两种视图）。旧插槽已在新版 harness 中被删除，不适配会导致卡片**静默消失**、无法配置 key 与代理。
- **compat** 同时保留旧的 `settings.plugin.item` 注册，新旧两代 harness 都能配置；等不再需要兼容旧版时，删除 `ui/client.js` 中标注 Legacy 的那段即可。
- **test** 浏览器 bundle 契约测试新增新插槽与两种视图的断言，旧插槽断言保留。

> 0.6.1（2026-09-16）：修复 0.6.0 浏览器半身崩溃导致卡片整块消失（`cannot get property "remote.settings" without inject`）；完整历史见 [change-log.md](./change-log.md)。

## 功能

安装后所有会话（所有 agent preset）都会获得 12 个 `jina_*` 工具：

| 工具 | 对应 jina-cli 命令 | 说明 |
| --- | --- | --- |
| `jina_web_search` | `jina search` | 通用网页搜索（默认 web 域；images / blog 域，支持时间过滤与地区/语言提示） |
| `jina_search_arxiv` | `jina search --arxiv` | arXiv 预印本检索（CS / ML / 数学 / 物理等，返回 arxiv.org 官方论文直链） |
| `jina_search_ssrn` | `jina search --ssrn` | SSRN 论文检索（经济 / 金融 / 法律 / 管理等社会科学，返回 papers.ssrn.com 直链） |
| `jina_read` | `jina read` | 把网页读成干净的 markdown |
| `jina_screenshot` | `jina screenshot` | 网页截图，返回托管图片 URL（支持整页截图） |
| `jina_datetime` | `jina datetime` | 推测网页的发布/更新时间 |
| `jina_expand` | `jina expand` | 把搜索词扩展成一组相关查询 |
| `jina_embed` | `jina embed` | 文本向量化（默认 jina-embeddings-v5-text-small） |
| `jina_rerank` | `jina rerank` | 按相关性重排文档（默认 jina-reranker-v3.5） |
| `jina_classify` | `jina classify` | 文本分类 |
| `jina_pdf` | `jina pdf` | 从 PDF 提取图表/公式（支持 arXiv ID） |
| `jina_primer` | `jina primer` | 获取当前上下文：主机时钟（ISO 时间/unix/时区/UTC 偏移）、网络事实（公网 IP 与位置，尽力而为）与 Jina 账户状态（身份/余额） |

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
├── index.js           # 主机插件：12 个工具（含 jina_search_arxiv / jina_search_ssrn 专用学术检索）+ 网络传输 + JINA_API_KEY 凭据解析 + jina-tools 代理设置
├── proxy.js           # 纯函数模块：代理地址规范化 / 优先级 / 设置 schema（零依赖，可单测）
├── primer.js          # 纯函数模块：jina_primer 的解析 / 格式化逻辑（零依赖，可单测）
├── test/
│   ├── primer.test.js        # jina_primer 单元测试（node --test 自动发现）
│   ├── proxy.test.js         # 代理策略单元测试
│   ├── plugin-proxy.test.js  # mock 宿主的代理集成测试（含可选实时代理用例）
│   ├── client-bundle.test.js # 浏览器 bundle 契约测试（语法 + 注册 id + settings 通道）
│   └── tools.test.js         # jina_web_search 模型可见契约测试（TDD）
├── ui/
│   ├── package.json   # 子包 manifest（exports["./client"]；dsh.client 主声明已在根包，此处仅保持子包完整）
│   ├── index.js       # 空主机半身（保留历史子包结构；组合层不再引用）
│   └── client.js      # 预构建浏览器 bundle：设置 → 插件 → 配置 的 "Jina Tools" 卡片（API key + 本地代理）
├── change-log.md      # 完整版本历史（简体中文）
├── change-log.en.md   # 完整版本历史（English）
├── README.md          # 简体中文说明（本文件）
└── README.en.md       # English README
```

## 开发说明

- 主机插件只依赖 Node 内置模块与 dsh 主机服务（`fs`、`subprocess`、`tools`、`credentials`、`settings`、`webServer`），无第三方 npm 依赖；凭据走 dsh 原生的 credential seam（引用 `JINA_API_KEY`），代理配置走插件自己的 `jina-tools` 设置命名空间（`proxyUrl` 字段，schema 是零依赖的 duck-type 节点，见 `proxy.js` 的 `createSettingsSchema`），任何 profile 组合都可以直接使用。
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
- `test/plugin-proxy.test.js`：用假 Cordis 上下文驱动主机半身，断言设置命名空间注册、代理优先级、**网络 helper 实际收到的环境变量**、错误文案与 `/api/dsh-jina/primer` 负载。其中带 `JINA_LIVE_PROXY=1` 的用例会真实 spawn helper 打通一次 Jina 请求（干净环境 + 手填代理，用来证明是手填地址而非残留环境变量在起作用）：

  ```powershell
  $env:JINA_LIVE_PROXY='1'; $env:JINA_LIVE_PROXY_URL='http://127.0.0.1:7897'; npm test
  ```

  在无法 spawn 子进程的沙箱里该用例会自动跳过并说明原因。
- `test/client-bundle.test.js`：解析预构建的 `ui/client.js` 并固化注册 id、`jina-tools` key、settings 通道与 revision 栅栏——bundle 没有构建步骤，语法错误只能在运行时暴露。
