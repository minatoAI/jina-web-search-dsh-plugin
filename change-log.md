# 更新日志

本文件记录 dsh-jina 的完整版本历史；[README.md](./README.md) 的「更新日志」一节只保留最新版本。

### 0.5.2（2026-08-29）

- **fix** 修复插件安装后 Web 页面报 `Failed to load plugins` 的问题（`failed to import loader entry … (dsh-jina): client-modules: bundle … loaded without registering "dsh-jina"`）：0.5.1 已把组合行改成精确包名 `dsh-jina`，但浏览器 bundle 内 `window.__ModuleLoader__.load` 的注册 id 仍是旧行名 `dsh-jina/ui`——模块系统只按图行 id（精确包名，`stripClientSuffix` 只剥尾部 `/client`）匹配注册，`dsh-jina/ui` 落到没人询问的键上，`arrive()` 检查 `factories.has('dsh-jina')` 为假 → 脚本加载成功但被判定「未注册」，整页 `Failed to load plugins`。修复：注册 id 改为图行 id `dsh-jina`。
- **fix** 凭据命名空间改为标准注入：核对 api-gateway client 源码确认 `remote.credentials` 是 gateway `$mount` 时以 `Service(ctx, 'remote.credentials')` 注册的**独立服务**（`remoteServiceKey('credentials')`），而不是 `remote` 服务对象上的属性——旧代码从 `ctx.get('remote')` 取 `.credentials` 会拿到 `undefined`。插件 `inject` 增加 `'remote.credentials'`，卡片直接接收该服务；`describe/set/unset` 契约与 `credentials/reference-updated` 事件（仍由 `remote` 服务转发）不变。

### 0.5.1（2026-08-29）

- **fix** 修复 Web 设置中「Jina Tools」配置选项卡消失的问题（在 dsh 0.1.2-alpha.1 + 运行中的 profile 实测定位）：新 harness 的 client-modules 扫描只把「行名 = 精确包名」的行纳入 `window.__DSH_BOOT__` 客户端图，子路径行（`dsh-jina/ui`）被判为「永远不是客户端行」——浏览器半身从不加载，`settings.plugin.item` 里没有 `jina-tools` 键，设置页因此渲染不出卡片（宿主侧 12 个工具与 `jina-tools` 命名空间均正常，故只有 UI 缺失）。修复：浏览器半身声明（`dsh.client` + `exports["./client"]`）上移到**根 manifest**，组合层改为单个双面孔行 `dsh-jina`（与 harness 自带的 `dsh-client-*` 同构），删除 `dsh-jina/ui` 行；卡片 key、凭据通道与事件名均不变。
- **docs** 更新「仓库结构」与「开发说明」，说明浏览器半身必须声明在根包这一 client-modules 扫描约束。

### 0.5.0（2026-08-29）

- **fix** 适配 dsh 0.1.2-alpha.1 的 apiproxy 重构（`refactor(apiproxy)!: remove settings and credentials RPCs`，2026-08-27）：浏览器半身的凭据 RPC 从已移除的 `connection.api.credentials.*` 迁移到 Typert Remote 凭据命名空间 `ctx.remote.credentials`（`credentials/describe|set|unset`）——`describe` 改为批量接收 `refs[]`、`set/unset` 改为位置参数，响应包络由 `{result:{ok,value}}` 改为 `{ok,value|error}`；变更事件 `credentials/updated` 同步更名为 `credentials/reference-updated`（仍由同一 `remote` 服务转发）。
- **fix** `dsh.client` 声明去掉对 `@deepseek-ai/dsh-client-runtime` 的图边依赖（该包在 0.1.2-alpha.1 已不存在），仅保留对 `@deepseek-ai/dsh-api-remotes` 的边；bundle 本身只依赖 baseline 的 react，无 `external` 请求。
- **fix** subprocess 句柄不再暴露 `exitCode` 属性：退出码改从 `handle.done` 的 `SubprocessOutcome` 读取（工具调用方本就不消费，纯契约对齐）。
- **verify** 其余表面逐项对照 dsh 0.1.2-alpha.1 源码确认兼容：`tools.register` 完整 JSON Schema 参数通过注册期规范化校验（`normalizeRegisteredParameters`）、`output {schema, render}` 契约不变、`credentials.resolve`、`webServer.register`、`settings.register`（空命名空间 duck-type schema）、`fs`/`sandboxPolicy`、keyed slot `settings.plugin.item` 与 `window.__ModuleLoader__` 客户端协议均未变化。
- **docs** README/README.en.md 更新日志同步为 0.5.0。

### 0.4.0（2026-08-18）

- **feat** 网页检索工具更名 `jina_search` → `jina_web_search`，工具名直接点明「web 搜索」，与内置 `web_search` 的命名信号对齐；描述重构为「任务优先 + 触发条件」：首句说明返回摘要与官方源置顶链接，`Use this whenever...` 写明何时调用（时效内容 / 新闻 / 时间过滤）及与内置 `web_search` 的分工（泛用 / 工程文档覆盖更广）；`query` 参数描述补充「配合 `time` 参数做时效检索」的指引。
- **refactor** 网页检索工具的模型可见契约（名称 / 描述 / 参数）抽为纯数据模块 `tool-contracts.js`，`index.js` 以展开方式注册；设置卡片提示文案同步更新。
- **test** 新增 `test/tools.test.js`（TDD，先红后绿）：固化 `jina_web_search` 的模型可见契约——改名、任务优先开头、触发条件、与内置 `web_search` 的分工、官方源 / 时效差异化信号、`query` 参数指引与描述长度预算。

### 0.3.1（2026-08-18）

- **fix** 适配 dsh 本体的 keyed slot 契约：设置 → 插件 → 配置 的 `settings.plugin.item` 插槽改为按「卡片编辑的设置命名空间」键控（同 `tool.call.toolview` 约定），配置区只派发主机已 serve 的命名空间对应卡片。
- **fix** 浏览器半身的 **Jina Tools** 卡片改用 `key: 'jina-tools'` 注册；主机半身新增同名 `jina-tools` 设置命名空间（空 schema、零依赖，仅用于配对；API key 仍只走 `JINA_API_KEY` 凭据通道），两侧命名空间一致时才渲染卡片。不含设置提供方的 profile 不挂载注入，其余行为不变。

### 0.3.0（2026-08-15）

- **feat** `jina_primer` 重做：返回真实上下文——主机时钟（ISO 时间 / unix / 时区 / UTC 偏移）、网络事实（公网 IP 与位置，尽力而为，失败时降级）与 Jina 账户状态（身份 / 余额）。解析与格式化抽成纯函数模块 `primer.js`，新增 17 个零依赖单元测试（`npm test`）。
- **fix** 工具描述不再把「需要 API key」列为前置条件。

### 0.2.0（2026-08-14）

- **feat** 新增 `jina_search_arxiv` / `jina_search_ssrn` 专用学术检索工具（对应 `jina search --arxiv` / `--ssrn`），工具名即用途；README 增加与内置 `web_search` 的交叉对比表。
- **feat** 设置页 **Jina Tools** 卡片实时显示当前 key 的身份与余额（经 `/api/dsh-jina/primer`，可手动刷新；保存 / 清除 key 后自动重检）。
- **feat** `jina_datetime` 返回提取出的标题 / 发布时间，不再吐原始 JSON 块。
- **fix** 工具参数改为规范的 JSON Schema；设置 UI 移入标准插件配置位置（设置 → 插件 → 配置）。
- **refactor** API key 改走 dsh 原生凭据通道（`JINA_API_KEY` credential seam）。
- **fix** 增强 `link:` 安装的 schemastery 解析；导出 `package.json` 子路径。
- **style** 设置页主题 token 增加降级颜色。
- **docs** 新增英文 README 与语言切换链接；修正 README 安装命令的仓库地址与 key 获取链接。

### 0.1.0（2026-08-14）

- **feat** 首版：dsh-jina bundle——10 个 `jina_*` 模型工具（search / read / screenshot / embed / rerank / classify / pdf / expand / datetime / primer）+ 设置页 API key 配置 UI。
