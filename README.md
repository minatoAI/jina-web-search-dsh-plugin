[English](README.en.md) | **简体中文**

# dsh-jina

DeepSeek Harness 的 [Jina AI](https://jina.ai/) 插件（bundle）：把 jina-cli 的全部 API 能力以模型工具的形式装进 dsh，并在 Web 设置的**插件 → 配置**页（与 终端 / Agent 循环 / 网页搜索 相同的标准插件配置位置）提供 **Jina Tools** 卡片来配置 API key。

## 更新日志

> 此处仅展示最新版本，完整版本历史见 [change-log.md](./change-log.md)。

### 0.5.0（2026-08-29）

- **fix** 适配 dsh 0.1.2-alpha.1 的 apiproxy 重构（`refactor(apiproxy)!: remove settings and credentials RPCs`）：浏览器半身的凭据 RPC 从已移除的 `connection.api.credentials.*` 迁移到 Typert Remote 凭据命名空间 `ctx.remote.credentials`（`credentials/describe|set|unset`）——`describe` 改为批量接收 `refs[]`、`set/unset` 改为位置参数，响应包络由 `{result:{ok,value}}` 改为 `{ok,value|error}`；变更事件 `credentials/updated` 同步更名为 `credentials/reference-updated`（仍由同一 `remote` 服务转发）。
- **fix** `dsh.client` 声明去掉对 `@deepseek-ai/dsh-client-runtime` 的图边依赖（该包在 0.1.2-alpha.1 已不存在，仅保留对 `@deepseek-ai/dsh-api-remotes` 的边；bundle 本身只依赖 baseline 的 react）。
- **fix** subprocess 句柄不再暴露 `exitCode` 属性：退出码改从 `handle.done` 的 `SubprocessOutcome` 读取（工具调用方本就不消费，纯契约对齐）。
- **verify** 其余表面逐项对照 dsh 0.1.2-alpha.1 源码确认兼容：`tools.register` 完整 JSON Schema 参数通过注册期规范化校验、`output {schema, render}` 契约不变、`credentials.resolve`、`webServer.register`、`settings.register`（空命名空间 duck-type schema）、`fs`/`sandboxPolicy`、keyed slot `settings.plugin.item` 与 `window.__ModuleLoader__` 客户端协议均未变化。

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

```sh
# 从 GitHub 安装（本项目无 build 脚本，无需 allowBuilds 授权）
dsh plugin --profile web add github:minatoAI/jina-web-search-dsh-plugin

# 更稳妥：固定到某个 commit，避免后续推送改变实际安装到的代码
dsh plugin --profile web add github:minatoAI/jina-web-search-dsh-plugin#<commit-sha>

# 或本地文件夹安装（开发调试用）
dsh plugin --profile web add ./jina-dsh-plugin
```

安装完成后**重启** dsh（新 bundle 在下次启动时生效）：

```sh
dsh --profile web
```

然后打开 Web 界面 → 设置 → **插件** → **配置** 选项卡 → 展开 **Jina Tools** 卡片 → 粘贴 API key → 保存。免费 key 在 https://jina.ai/ 获取。

卡片中的 **API key 检测** 区域会实时显示当前 key 的身份（Jina 账号）与余额（credits），并标注 key 的来源（本页保存 / key 文件 / 匿名配额），用于确认 key 是否真正生效；点击「刷新」重新检测（保存/清除 key 后也会自动重检）。该数据由主机端插件通过 `/api/dsh-jina/primer` 路由提供（与 `jina_primer` 工具同一接口），**key 明文永不离开主机**。

## API key 解析顺序

每次工具调用按以下顺序找 key（任一命中即用）：

1. 工具调用参数 `apiKey`
2. 设置页保存的 key（credential 引用 `JINA_API_KEY`，由 dsh 凭据存储持久化，如 `~/.dsh/.credentials.yaml`）
3. 会话工作区的 `jina-api-key.txt`
4. dsh 主目录（`$DSH_HOME`，默认 `~/.dsh`）下的 `jina-api-key.txt`

设置页保存新 key 后立即生效（无需重启，每次调用即时解析）；HTTP 401 时也会自动重读文件并重试一次。凭据值只通过 `credentials.set` 上行，任何读取接口都不会回传明文。同时支持在页面上一键清除。

## 网络与代理（中国大陆用户）

Jina 域名被直连网络屏蔽，需要 VPN。插件通过系统代理访问 Jina：每次调用前从 WinINET 注册表发现系统代理地址，传输失败时自动重新发现并重试一次——VPN 重启换了端口也能自愈。VPN 未开时工具会返回带提示的错误信息。

## 卸载

```sh
dsh plugin --profile web remove dsh-jina
```

## 仓库结构

```
jina-dsh-plugin/
├── package.json       # manifest: "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├── cordis.patch.yml   # 组合层：插入 dsh-jina（主机工具行）与 dsh-jina/ui（客户端 UI 行）
├── index.js           # 主机插件：12 个工具（含 jina_search_arxiv / jina_search_ssrn 专用学术检索）+ 网络传输 + JINA_API_KEY 凭据解析
├── primer.js          # 纯函数模块：jina_primer 的解析 / 格式化逻辑（零依赖，可单测）
├── test/
│   ├── primer.test.js # jina_primer 单元测试（node --test 自动发现）
│   └── tools.test.js  # jina_web_search 模型可见契约测试（TDD）
├── ui/
│   ├── package.json   # dsh.client 声明（platform: web）
│   ├── index.js       # 空主机半身（保证 loader 行可用）
│   └── client.js      # 预构建浏览器 bundle：设置 → 插件 → 配置 的 "Jina Tools" 卡片
├── change-log.md      # 完整版本历史（简体中文）
├── change-log.en.md   # 完整版本历史（English）
├── README.md          # 简体中文说明（本文件）
└── README.en.md       # English README
```

## 开发说明

- 主机插件只依赖 Node 内置模块与 dsh 主机服务（`fs`、`subprocess`、`tools`、`credentials`），无第三方 npm 依赖；凭据走 dsh 原生的 credential seam（引用 `JINA_API_KEY`），任何 profile 组合都可以直接使用。
- 客户端 bundle 直接提交（`ui/client.js`），无构建步骤，git 安装开箱即用。改 UI 后直接改该文件并重启即可。卡片注册进 Web 设置包声明的 `settings.plugin.item` 插槽（设置 → 插件 → 配置），这是第三方插件配置的标准位置；key 通过标准的 `ctx.remote.credentials` 凭据 Remote（`credentials.describe/set/unset`，变更事件 `credentials/reference-updated`）管理——这是唯一对第三方插件开放的配置通道，settings 命名空间对浏览器有白名单限制。
- 组合层遵循 dsh 约定：主机行 `dsh-jina` 注册模型工具；客户端行 `dsh-jina/ui` 由 host 的 client-modules 服务通过 `ui/package.json` 的 `dsh.client` 声明发现并接入 Web boot graph。

## 测试

纯函数逻辑（primer 解析/格式化等）使用 Node 内置测试运行器，零依赖：

```sh
npm test   # 等价于 node --test（自动发现 test/*.test.js）
```

测试用真实抓取的 r.jina.ai / ipinfo.io 响应形状作为 fixture，覆盖解析容错、
时间事实推导、文本/JSON 两种渲染与“不输出 undefined”等契约。
