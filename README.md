[English](README.en.md) | **简体中文**

# dsh-jina

DeepSeek Harness 的 [Jina AI](https://jina.ai/) 插件（bundle）：把 Jina Reader / Search 的 API 能力以模型工具的形式装进 dsh，并在 Web 的 **Plugins** 侧边栏页（`dsh-jina` bundle 卡片）提供配置表单来设置**多个 API key（额度耗尽自动切换）**与**接口域名（国内镜像 / 国际 / 自动）**；旧版 harness 上则回落到 **设置 → 插件 → 配置** 的同名卡片。

> **不需要代理。** Jina 的全球域名（`r.jina.ai` / `s.jina.ai`）在中国大陆被 DNS 污染、源站不可达，插件默认走 Jina 官方提供的国内镜像 `r.jinaai.cn` / `s.jinaai.cn`（国内 CDN，同一套接口与认证），直连即可。插件本身**不再配置任何代理**。

## 更新日志

> 此处仅展示最新版本，完整版本历史见 [change-log.md](./change-log.md)。

### 0.12.1（2026-09-24）

- **fix** **`jina_read` 不再因为默认选择器组卡死**。`X-Target-Selector` 隐含服务端 `X-Wait-For-Selector`，选择器命不中时服务端会一直等到 `X-Timeout`——原来是 120s，与客户端自己的 120s 上限撞在一起，于是"默认选择器列表不适配这页"被报成**网络超时**（实测：某新闻页带选择器组的请求 >45s 无响应，而同一页不带选择器组 30s 就回来了；你在 36kr 那页遇到的就是这个）。现在带目标选择器的那次尝试把服务端耐心降到 **30s**、客户端上限降到 **45s**，服务端必定先应答（通常就是既有的 422），"整页重读"回退随即生效；并且新增**第三种回退形态**：选择器尝试直接超时（status 0）时也改用整页重读，而不是报网络错误。**实测**：163.com 那页 4.3s 成功、36kr 1.9s 成功，各两次尝试（选择器 → 整页）。
- **fix** **`targetSelector: ""` 现在真的表示"读整页"**。此前空字符串会回落到内置列表，导致 422 提示里那句 `retry with targetSelector: ""` 是失效建议；现在只有**不传**该参数才回落到配置列表 / 内置列表，显式传空串则不发 `X-Target-Selector`（`X-Remove-Selector` 的噪声清理仍然保留）。
- **fix** **`jina_primer` 的网络段恢复**。`ipinfo.io` 的请求此前被新的端点路由吞掉（打到 Reader 根、拿回 usage 文本），`network` 一直是 `null`。现在 `jinaRequest` 支持**显式绝对 URL 逃生口**，只有 Jina 主机才走端点表。实测恢复为真实公网 IP / 城市 / ASN。
- **test** 全套 **155 例：154 通过 / 1 例按需跳过 / 0 失败**。新增 4 例：选择器尝试的耐心与客户端上限、显式空 `targetSelector` 读整页、选择器尝试超时→整页回退、无选择器组时传输失败只报域名不重试；以及 `jina_primer` 的 ipinfo 绝对 URL 回归。

> 0.12.0（接口域名开关、移除 5 个工具与整套代理机制）的完整说明见 [change-log.md](./change-log.md)。

## 功能

安装后所有会话（所有 agent preset）都会获得 8 个 `jina_*` 工具：

| 工具 | 对应 jina-cli 命令 | 说明 |
| --- | --- | --- |
| `jina_web_search` | `jina search` | 通用网页搜索（默认 web 域；images / blog 域，支持时间过滤与地区/语言提示） |
| `jina_search_arxiv` | `jina search --arxiv` | arXiv 预印本检索（CS / ML / 数学 / 物理等，返回 arxiv.org 官方论文直链；用 `site: arxiv.org` 限定来源） |
| `jina_search_ssrn` | `jina search --ssrn` | SSRN 论文检索（经济 / 金融 / 法律 / 管理等社会科学，返回 papers.ssrn.com 直链；用 `site: ssrn.com` 限定来源） |
| `jina_read` | `jina read` | 把网页读成干净的 markdown；支持正文选择器与噪声过滤（见下节）。**PDF 一律走普通抽取**——逐字，且比 OCR 便宜约 40× |
| `jina_read_pdf` | `jina read` + `X-Respond-With: jina-ocr-v1` | **专门用 `jina-ocr-v1` 逐页读 PDF**：扫描件 / 图片型 PDF 唯一可用的路径。`pages` 选页（`"3"` / `"1-5"` / `"2,4,7"`），默认前 5 页（`maxPages`，上限 50）。**一次一页**（API 对超出页数的 `X-Page` 会静默返回第 1 页，工具据此判定文档结尾）；结果自带来源标记 |
| `jina_screenshot` | `jina screenshot` | 网页截图，返回托管图片 URL（支持整页截图） |
| `jina_datetime` | `jina datetime` | 推测网页的发布/更新时间 |
| `jina_primer` | `jina primer` | 获取当前上下文：主机时钟（ISO 时间/unix/时区/UTC 偏移）、网络事实（公网 IP 与位置，尽力而为）与 Jina 账户状态（身份/余额） |

## 阅读工具选项（`jina_read`）

卡片里的「阅读工具选项」区块（也可直接改 `settings.yaml` 的 `jina-tools` 段）决定 `jina_read` 的默认行为；每个选项都能被同名调用参数**单次覆盖**。

| 选项 | 字段 | 默认 | 作用与代价 |
| --- | --- | --- | --- |
| 图片保留策略 | `imagePolicy` | `all` | `all` = 官方默认；`alt` = 只保留 alt 文本（省 token）；`none` = 不保留图片 |
| 生成图片 alt 文本 | `autoAltText` | 关 | `X-With-Generated-Alt`：为缺说明的图片生成描述。**需 API key**（匿名 401），且**与 OCR 互斥**（指定 `X-Respond-With` 时该功能不生效）；又因为**带 key 的请求会计费**，默认关闭，需要时显式打开 |
| 选择器组 | `useSelectors` | 开 | 默认发保守的 `X-Target-Selector`（只含 `article` / `main` / `[role="main"]` / `.markdown-body` 等正文容器）与 `X-Remove-Selector`（页眉页脚、导航、cookie 横幅、广告、侧栏、评论等）。命中不到时**自动回退整页重试**，不会返回空 |
| 正文 / 排除选择器 | `targetSelector` / `removeSelector` | 空 = 内置列表 | 覆盖内置选择器（站点结构特殊、默认列表误伤时用） |

每次 `jina_read` 还会固定发送三个零副作用参数：`X-Preset: agent`（官方为 AI agent 预调的预设；官方文档明确 preset **只填充调用方未显式设置的选项**，所以不会覆盖任何显式参数）、`X-Base: final`（用重定向后的最终 URL 解析相对链接）、`X-Timeout: 120`（与客户端自己的 120s 上限对齐——若发官方的上限 180，客户端会先超时并报自己的错误，多出来的耐心是浪费的；要改就两边一起改）。**例外**：带目标选择器的那次尝试，服务端耐心压到 30s、客户端上限 45s——因为 `X-Target-Selector` 隐含 `X-Wait-For-Selector`，"命不中就一直等"会撞上客户端上限而被误报成网络超时（0.12.1）。

调用级参数（`jina_read`）：`targetSelector`、`waitForSelector`、`removeSelector`、`noCache`，以及原有的 `links` / `images` / `json` / `apiKey`。
调用级参数（`jina_read_pdf`）：`url`、`pages`、`maxPages`、`allowNonPdf`、`apiKey`。非 `.pdf` 的 URL 会被拒绝（`allowNonPdf: true` 可强制放行）——因为 `jina-ocr-v1` 在普通网页上会**编造内容**。

> 关于"为什么默认这样"：这三项是官方 Reader API 里**最坏情况不损失什么**的参数；而 alt 生成需要 key 且会计费，所以默认关闭。`X-Remove-Overlay` / `X-Detach-Invisibles` 这两个未在官方参数面板文档化的隐藏参数**没有**被默认启用（后者官方明确要求 browser 引擎且禁用缓存）。

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

然后打开 Web 界面 → 设置 → **插件** → **配置** 选项卡 → 展开 **Jina Tools** 卡片 → 在 **API key** 区块里粘贴 key → 点「添加」。可以**一直往里加**：每次点「添加」都会保存一个新 key，卡片不显示也不需要管理任何单个 key。免费 key 在 https://jina.ai/ 获取。**建议至少加两个**：任一 key 失效或额度耗尽时插件会自动丢弃它并切换到下一个，任务不会中途断掉（见下节）。

## 更新

插件是 profile 的一个依赖，升级 = **让 profile 重新拉取远端代码 + 重启 dsh**。以 `web` profile 为例：

1. 让 profile 拿到新版本（三选一）：

   ```sh
   # A. 命令行：重新解析 GitHub 依赖（推荐）
   cd "$DSH_HOME/profiles/web"        # Windows: C:\Users\<你>\.dsh\profiles\web
   pnpm update dsh-jina

   # B. 命令行：先卸载再安装（与 A 等效，会重新拉取分支最新 commit）
   dsh plugin --profile web remove dsh-jina
   dsh plugin --profile web add github:minatoAI/jina-web-search-dsh-plugin

   # C. Web 界面：侧边栏「插件」页 → 卸载 dsh-jina → 用上面的 GitHub 地址重新安装
   ```

2. **重启** dsh 让新代码生效：

   ```sh
   dsh --profile web
   ```

3. 核对是否更新成功：

   ```sh
   # 已安装副本的版本号（本仓库每次发版都会在 package.json 里改版本）
   Get-Content "$DSH_HOME/profiles/web/node_modules/dsh-jina/package.json" | Select-String '"version"'
   ```

   然后打开卡片点一次「刷新」确认功能正常（例如「Key 总数 / 总余额」这两行）。

> **为什么只跑 `pnpm install` 通常不会升级**：GitHub 依赖会被 `pnpm-lock.yaml` 固定到安装当时的 commit，`pnpm install` 尊重锁文件；只有 `pnpm update dsh-jina`（或先 remove 再 add）才会重新解析到分支最新 commit。安装时按 commit 固定（`...#<commit-sha>`）也是同理——升级要显式改成新的 SHA。
>
> 本地文件夹安装（`add ./jina-dsh-plugin`）不经过远端：在该目录 `git pull` 之后重启 dsh 即可。

同一张卡片里还有 **接口域名**：一个三选一的下拉，决定每次调用走哪一对域名——**国内**（`r.jinaai.cn` / `s.jinaai.cn`，Jina 官方国内镜像，国内 CDN 直连、不需要代理/VPN）、**国际**（`r.jina.ai` / `s.jina.ai`）、**自动**（默认：先用上次可用的那一侧，失败后自动改用另一侧）。选中即保存，下一次工具调用立即生效，不需要重启 dsh。

卡片中的 **API key / 连接检测** 区域只报告两件事：**Key 总数**与**总余额**（存活 key 的 credits 之和），另外显示连接状态与**本次检测实际使用的接口域名**；点击「刷新」重新检测（添加 key 或域名变更后也会自动重检）。**不显示任何单个 key 的信息**——没有 key 明文、没有指纹、不标识正在使用哪一个、也没有手动移除。该数据由主机端插件通过 `/api/dsh-jina/primer` 路由提供（与 `jina_primer` 工具同一接口），**key 明文永不离开主机**。

## API key 解析顺序与自动轮换

每次工具调用按以下顺序找 key；**第一个有 key 的来源就是本次的轮换池**（同一来源里的多个 key 全部进入轮换，命中即不再看后面的来源）：

1. 工具调用参数 `apiKey`（**单个，不参与轮换**——这是「只用这一个 key」的逃生口）
2. 卡片里添加的 key，按添加顺序（保存在 dsh 凭据存储，如 `~/.dsh/.credentials.yaml`；也可用同名环境变量，headless profile 同样适用）
3. 会话工作区的 `jina-api-key.txt`（**每行一个 key**，空行与 `#` 注释忽略）
4. dsh 主目录（`$DSH_HOME`，默认 `~/.dsh`）下的 `jina-api-key.txt`（同样每行一个 key）

### 轮换与自动丢弃规则

| 上游状态 | 含义 | 行为 |
| --- | --- | --- |
| `401` | key 失效 / 被撤销 | 换下一个 key，并**从凭据存储里自动丢弃**该 key |
| `402` | 额度耗尽 | 换下一个 key，并**自动丢弃**该 key |
| 余额 ≤ 0 | 卡片检测时发现额度已空 | **自动丢弃**该 key |
| `429` | 限流 | 换下一个 key，但**不丢弃**（临时状态），冷却 1 分钟后自动回到轮换 |
| `0` / `422` / `5xx` | 网络、参数、上游故障 | **不轮换也不丢弃**（换 key 解决不了，只会浪费掉其余 key 的请求） |

- **自动管理**：能用的 key 一直留着，不能用的自动丢弃——所以卡片里没有「移除」，也没有任何单个 key 的展示，用户只需要往里加。
- **均流（round-robin）**：每次调用都从**上一个用过的 key 的下一个**开始，N 个 key 各摊约 1/N 的流量——Jina 的限流（RPM/TPM）按 key 计，摊开才能少撞 429。**计划内的轮换不会**显示"已自动切换"（只有真正失败导致的换 key 才显示那一行）。
- **切换可见**：调用中途换过 key 时，返回末尾会附一行，形如 `[已自动切换 API key：#1（凭据 JINA_API_KEY）额度耗尽（HTTP 402），已自动移除；改用 #2（凭据 JINA_API_KEY_2）。可在 Plugins → dsh-jina 卡片里添加新的 key。]`；`json: true` 的原始负载不附加任何文字。
- **全池耗尽**：错误信息逐个列出尝试过的 key、来源与各自状态（例如 `#1（凭据 JINA_API_KEY）额度耗尽（HTTP 402），已自动移除；#2（工作区 jina-api-key.txt 第 2 行）限流（HTTP 429）`），并提示添加 key 或充值。
- 添加 key 后立即生效（无需重启，每次调用即时解析；凭据值只通过 `credentials.set` 上行，任何读取接口都不会回传明文）。
- 同一个 key 在多个槽位或文件里重复出现时只请求一次。
- **key 文件与只读来源不会被删除**：`jina-api-key.txt` 里的 key（插件不会改写用户的文件）和由启动环境变量只读提供的引用（seam 拒绝写入）只会被跳过冷却，不会从磁盘上消失。

## 接口域名（不需要代理）

Jina 的全球域名 `r.jina.ai` / `s.jina.ai` 在中国大陆被 **DNS 污染**，源站地址也被黑洞，直连必然失败。Jina 官方为此提供了国内镜像域名（见 [jina-ai/reader#1237](https://github.com/jina-ai/reader/issues/1237)）：`r.jina.ai → r.jinaai.cn`、`s.jina.ai → s.jinaai.cn`，**接口、参数、认证方式完全一致，只需替换域名**。

| 模式 | 使用的域名 | 适用 |
| --- | --- | --- |
| `cn`（国内） | `r.jinaai.cn` / `s.jinaai.cn` | 中国大陆网络。国内 CDN 直连，**不需要任何代理**；固定这一侧时不会回落到国际域名 |
| `global`（国际） | `r.jina.ai` / `s.jina.ai` | 海外网络，或自备代理时 |
| `auto`（默认） | 两侧都用 | 先用上次可用的那一侧，失败后自动改用另一侧。**每个 host 只试一次**，一次调用最多两次尝试；进程内记住胜者，所以只有第一次调用可能多花一次探测时间 |

规则与注意事项：

- **插件不再配置任何代理**：卡片上没有代理输入框，也不读 `JINA_PROXY_URL`。你仍然可以自己用 VPN/系统代理，但插件不会去发现或设置它们。
- **国内域名的请求会绕过继承来的代理**：如果启动 dsh 的环境里带着 `HTTP_PROXY` / `HTTPS_PROXY`，国内域名的尝试会把 `jinaai.cn` **追加**到 `NO_PROXY`（保留原有列表），避免把国内 CDN 地址塞进 VPN。
- **实测数据**：`r.jinaai.cn` 不走代理直连 200，返回内容与经代理访问 `r.jina.ai` 逐字节一致（7521 字符、同一标题），稳定后 1.1–1.2s（首次冷启 24.8s，CDN 回源预热）；`s.jinaai.cn` 搜索接口带 key 返回 200。`api.jina.ai` 没有国内域名（`api.jinaai.cn` → HTTP 525），且其 SNI 被阻断（同一 CF IP 用 SNI `cloudflare.com` 正常、用 SNI `api.jina.ai` 立即 ECONNRESET），这也是 `jina_embed` / `jina_rerank` / `jina_classify` 被移除的原因。
- **错误信息会点名实际尝试过的域名**，例如「已尝试的接口域名：https://r.jina.ai/、https://r.jinaai.cn/」，便于判断是国际侧被墙还是本机网络整体不通。
- 域名的落地 IP 变化时不需要改配置（走系统 DNS 解析）；若某天官方下线 `.cn` 域名，把模式改成「自动」或「国际」并自备代理即可。
- **升级提示**：0.11.x 及更早版本可能在 `jina-tools` 段里存过 `proxyUrl`。新版本不再读取该字段，**留着无害**；想让配置干净可以删掉那一行。

## 卸载

```sh
dsh plugin --profile web remove dsh-jina
```

## 仓库结构

```
jina-dsh-plugin/
├── package.json       # manifest: "dsh": { "bundle": {"patch": ...}, "client": {"platform": "web"} }; 浏览器半身经 exports["./client"] 指向 ui/client.js
├── cordis.patch.yml   # 组合层：单个双面孔行 dsh-jina（宿主工具 + 浏览器卡片；行名 = 精确包名是 client-modules 扫描的硬条件）
├── index.js           # 主机插件：8 个工具（含 jina_search_arxiv / jina_search_ssrn 专用学术检索、jina_read_pdf 专用 OCR）+ 网络传输（双端点路由）+ 多 key 均流池（JINA_API_KEY / _2 … _10 + key 文件）
├── keys.js            # 纯函数模块：key 池策略（凭据引用 / key 文件解析 / 轮换顺序与冷却 / 状态标签，零依赖，可单测）
├── settings.js        # 纯函数模块：端点策略（国内 / 国际 / 自动的路由顺序与 NO_PROXY 覆盖）+ 阅读策略默认值与设置 schema（零依赖，可单测）
├── primer.js          # 纯函数模块：jina_primer 的解析 / 格式化逻辑（零依赖，可单测）
├── test/
│   ├── primer.test.js        # jina_primer 单元测试（node --test 自动发现）
│   ├── settings.test.js      # 端点策略单元测试（模式校验 / 路由顺序 / NO_PROXY 合并）
│   ├── keys.test.js          # key 池策略单元测试（轮换 / 冷却 / 解析 / 自动丢弃判定）
│   ├── multi-key.test.js     # mock 宿主的多 key 集成测试（逐请求断言 Authorization 与 failover）
│   ├── plugin-endpoints.test.js # mock 宿主的端点路由集成测试（含可选实时国内域名用例）
│   ├── reader-headers.test.js# jina_read 请求头契约测试（解码 helper 的 stdin，断言真实发出的头）
│   ├── client-bundle.test.js # 浏览器 bundle 契约测试（语法 + 注册 id + settings 通道 + 单输入 key 表单接线）
│   ├── client-render.test.js # 在 VM 中真实渲染两种视图（抓作用域/绑定类缺陷）
│   └── tools.test.js         # jina_web_search 模型可见契约测试（TDD）
├── ui/
│   ├── package.json   # 子包 manifest（exports["./client"]；dsh.client 主声明已在根包，此处仅保持子包完整）
│   ├── index.js       # 空主机半身（保留历史子包结构；组合层不再引用）
│   └── client.js      # 预构建浏览器 bundle：Plugins 页的 "Jina Tools" 卡片（单输入 key 表单 + 接口域名 + 阅读选项）
├── change-log.md      # 完整版本历史（简体中文）
├── change-log.en.md   # 完整版本历史（English）
├── README.md          # 简体中文说明（本文件）
└── README.en.md       # English README
```

## 开发说明

- 主机插件只依赖 Node 内置模块与 dsh 主机服务（`fs`、`subprocess`、`tools`、`credentials`、`llm`、`webServer`），无第三方 npm 依赖；凭据走 dsh 原生的 credential seam（key 池引用 `JINA_API_KEY` / `JINA_API_KEY_2` … `JINA_API_KEY_10`，seam 一个引用存一个值、且任何读取接口都不回传值，所以「多个 key」=「多个引用」；引用名只要满足 POSIX 标识符语法即可，无需 harness 改动），配置走插件自己的 `jina-tools` 设置命名空间（`endpoint` 接口域名 + `imagePolicy` / `autoAltText` / `useSelectors` / 三个选择器覆盖等阅读策略），任何 profile 组合都可以直接使用。
- **设置通道的契约（dsh 0.1.4 起）**：`settings.register()` 已被删除，**设置命名空间就是 Loader/profile 组合条目的 id**——本插件在 `cordis.patch.yml` 里插入的行 id 正是 `jina-tools`，所以卡片里的 `NS` 与之一致。插件通过 `index.js` 的 `export const Config = createSettingsSchema()`（`settings.js`，零依赖手写节点）声明可编辑字段：每个字段节点带 `meta.volatile: true`，`'~standard': { version: 1, vendor: 'schemastery', validate }` 是 harness 解析配置的唯一入口（`resolveConfig()` 要求**同步**返回纯对象；`vendor` 必须是 `'schemastery'`，否则每次保存都会退化成整插件重挂载）。`validate()` 为每个字段生成一个**跨副本安全的 volatile 引用**（`Symbol.for('cosmokit.volatile.write')`），harness 保存时只把新值写进这些引用，`apply(ctx, config)` 拿到的对象身份不变、插件不重挂载；插件在**每次操作**里用 `settingsSnapshot(config)` 重新读取（`toolSettingsOf()` 负责把"未设置"归一成默认值），因此保存与 API key 一样**立即生效、无需重启**。`/api/dsh-jina/primer` 的 `settingsLive` 就是这个契约的健康检查。
- 客户端 bundle 直接提交（`ui/client.js`），无构建步骤，git 安装开箱即用。改 UI 后直接改该文件并重启即可。bundle 顶层 `window.__ModuleLoader__.load` 的注册 id **必须等于图行 id（精确包名 `dsh-jina`）**——模块系统只按图行 id 匹配注册（`/client` 后缀除外），注册在别的键上（如旧行名 `dsh-jina/ui`）会报 `loaded without registering "dsh-jina"` 并导致整页 `Failed to load plugins`。卡片注册进 Web 设置包声明的 `settings.plugin.item` 插槽（设置 → 插件 → 配置），这是第三方插件配置的标准位置。
- **`remote.<ns>` 的注入铁律**：gateway `$mount` 时会把每个 Remote 命名空间注册成**独立 cordis 服务**，所以客户端插件读取 `remote.<ns>`（如 `remote.credentials`、`remote.settings`）之前，必须在自己的 `inject` 里声明该服务名——只声明 `'remote'` 是不够的，属性访问本身就会抛 `cannot get property "remote.settings" without inject`，而错误冒到 `settings.plugin.item` 的 slot 边界会让**整张卡片消失**（0.6.0 的回归，现已由 `test/client-bundle.test.js` 固化）。本插件的 `inject = ['slots','remote','remote.credentials','remote.settings']`。读取处仍然包一层 try/catch：服务缺失时降级为提示，不让 slot 崩溃。
- key 通过凭据 Remote 命名空间管理（`credentials.describe/set/unset`，变更事件 `credentials/reference-updated` 由 `remote` 服务转发）：卡片一次性 `describe(KEY_REFS)` 拿全部槽位的「是否已配置 / 来源 / 是否可写」（**永远拿不到值**，值只在保存时单向上行），表单因此只有**一个输入框**——「添加」把 key 写进第一个空槽位；宿主半身在 401/402 或探测到余额为 0 时用 `credentials.unset` **自动删除**该槽位（卡片自身不调用 `unset`，也不展示任何单个 key）。`ui/client.js` 里的 `KEY_REFS` 必须与 `keys.js` 的 `KEY_REFS` 完全一致（凭据命名空间没有枚举接口，卡片只能描述自己写下的引用名），由 `test/client-bundle.test.js` 固化。轮换/冷却策略在 `keys.js`（纯函数），宿主半身每次操作重新解析整池（与 key 的「每次调用即时解析」契约一致），`/api/dsh-jina/primer` 并行探测每个 key 并清理死 key，只回传**可用数量 / Key 总数 / 总余额 / 本次丢弃数**四个数字。接口域名字段走 `settings` Remote 命名空间（`remote.settings.describe/mutate`，写入按读到的 `revision` 设栅；外部编辑由转发事件 `settings/document-updated` 触发热重读）。
- 组合层遵循 dsh 约定：单个双面孔行 `dsh-jina` 同时携带宿主半身与浏览器半身。浏览器半身由**根 manifest** 的 `dsh.client`（platform: web，图边注入 `@deepseek-ai/dsh-api-remotes`）与 `exports["./client"]` 声明，host 的 client-modules 服务扫描时按行名（精确包名）定位根 manifest 并接入 Web boot graph。注意 client-modules 扫描只接受精确包名行：子路径行（如 `dsh-jina/ui`）永远不会被扫描为客户端行——浏览器半身必须声明在根包。

## 测试

纯函数逻辑（端点策略、primer 解析/格式化等）使用 Node 内置测试运行器，零依赖：

```sh
npm test   # 等价于 node --test（自动发现 test/*.test.js）
```

- `test/settings.test.js`、`test/primer.test.js`、`test/keys.test.js`、`test/tools.test.js`：纯函数与模型可见契约（`keys.test.js` 覆盖凭据引用语法、key 文件解析、状态归类、冷却折叠、轮换顺序、池签名与来源标签；`settings.test.js` 覆盖端点模式校验、路由顺序、`NO_PROXY` 合并）。
- `test/multi-key.test.js`：用假 Cordis 上下文驱动主机半身，逐请求解码网络 helper 的 stdin 并断言 `Authorization`，覆盖 402→备用 key 接管并**从凭据存储删除**该 key、401 同样丢弃、429 只跳过、只读环境变量与 key 文件来源不被删除、均流轮换与冷却跳过、三 key 顺序轮换、422/5xx/网络失败不轮换（传输失败只换端点域名，不轮换 key）、显式 `apiKey` 不轮换、全池耗尽的逐 key 报错、key 文件回退与多行解析、同 key 去重、添加 key 下一次调用即生效，以及 primer 路由只返回数量与总额且余额为 0 的 key 被丢弃。
- `test/reader-headers.test.js`：用假 Cordis 上下文驱动主机半身，**解码网络 helper 的 stdin**，逐条断言 `jina_read` 真实发出的 Reader 请求头——固定参数（`X-Preset: agent` / `X-Base: final`）、`X-Timeout` 与客户端上限按"带不带目标选择器"分成 30s/45s 与 120s/120s 两档、图片策略、选择器组的三种回退（短正文 / 422 / 超时）与"显式空 `targetSelector` 读整页"、OCR 开关与 `X-Page`、无 key 时零请求、alt 生成的 opt-in / 需 key / 与 OCR 互斥、JSON 信封解包与 usage、不可解析响应原文兜底，以及设置 schema 的字段声明（7 个字段都带 `meta.volatile`）、`validate` 的容错面与"保存后下一次调用即生效"。
- `test/plugin-endpoints.test.js`：用假 Cordis 上下文驱动主机半身，断言 `Config` 导出的 volatile 契约、**每次尝试真实请求的 URL**、**网络 helper 实际收到的环境变量**（国内域名附加 `NO_PROXY`、其他情况完整继承）、错误文案里实际尝试过的域名，以及 `/api/dsh-jina/primer` 负载（含 `settingsLive` 与本次使用的端点侧）。其中带 `JINA_LIVE_CN=1` 的用例会真实 spawn helper 打通一次国内域名请求：

  ```powershell
  $env:JINA_LIVE_CN='1'; npm test
  ```

  在无法 spawn 子进程的沙箱里该用例会自动跳过并说明原因。
- `test/client-bundle.test.js`：解析预构建的 `ui/client.js` 并固化注册 id、`jina-tools` key、settings 通道与 revision 栅栏、**单输入 key 表单**（一个 `keyDraft` 字符串 + `firstFreeRef` + 添加，且卡片自身不调用 `unset`）与 `keys.js` 的引用表一致性——bundle 没有构建步骤，语法错误只能在运行时暴露。
