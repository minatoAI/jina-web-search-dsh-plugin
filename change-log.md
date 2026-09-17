# 更新日志

本文件记录 dsh-jina 的完整版本历史；[README.md](./README.md) 的「更新日志」一节只保留最新版本。

### 0.7.1（2026-09-18）

- **fix** 修复 0.7.0 引入的**配置表单崩溃 → API key 与本地代理输入框在 Plugins 页整块消失**（实测控制台：`ReferenceError: input is not defined`，随后 `slot entry crashed in 'plugins.bundle.config'`）：0.7.0 为了给 `summary` / `page` 两种视图复用，把表单函数 `body()` 从 `JinaCard` 组件里提到了 factory 作用域，但它读取的全是组件内的 state 与 handler（`input` / `onInput` / `onSave` / `onClear` / `configured` / `status` / `statusStyle` / `shown` / `proxyBlock` / `primerBlock` / `view` / `writable`）——这些绑定在 factory 作用域全都解析不到，slot 一渲染就抛错，Plugins 页把整个配置区替换为 error boundary。修复：把 `body()` 移回组件内部（并加注释说明它必须留在里面，以及为什么）。
- **fix** 同一缺陷也让旧的 `settings.plugin.item` 折叠卡片在展开时崩溃，随本次修复一并恢复。
- **test** 新增 `test/client-render.test.js`：在 `node:vm` 中真实执行 `ui/client.js`、按 `window.__ModuleLoader__` 契约取出 factory、用假 cordis 上下文挂载插件，再按 React 的方式渲染 `summary` 与 `page` 两种视图（含旧卡片的展开态），断言 API key 输入框与本地代理输入框都被渲染出来。原有的 `test/client-bundle.test.js` 只对源码做正则匹配，**测不到这类作用域缺陷**——本测试即为该盲区的回归线。

### 0.7.0（2026-09-17）

- **compat** 适配新版 dsh：插件配置页的宿主插槽由 `settings.plugin.item`（keyed，Settings → Plugins → Configure）改为 `plugins.bundle.config`（keyed by bundle 包名，随 Plugins 页的 dsh-jina bundle 卡片一起渲染）。旧插槽在新版 harness 上**已被删除**，若不适配，`slots.inject` 会一直等待一个永不出现的声明方 → 卡片静默消失，用户无法再配置 API key 与本地代理。新增注册：`{ name: 'plugins.bundle.config', key: 'dsh-jina' }`；新宿主会向条目索取两种视图——`summary`（标题下的一行说明）与 `page`（自带保存控件的表单），`ui/client.js` 按 `props.view` 分支渲染。
- **compat** 保留旧的 `settings.plugin.item` 注册（`key: 'jina-tools'`），使同一个 bundle 在新旧两代 harness 上都能配置：两个 `slots.inject` 各自等待自己的声明方，任一存在即挂载。等所有受支持的 harness 都声明新插槽后，可删除 `ui/client.js` 里标注为 Legacy 的那一段。
- **test** `test/client-bundle.test.js` 增加新插槽与两种视图的契约断言；旧插槽断言保留为兼容回归线。

### 0.6.1（2026-09-16）

- **fix** 修复 0.6.0 引入的**浏览器半身崩溃 → Jina Tools 卡片整块消失**（用户实测控制台报错：`Error: cannot get property "remote.settings" without inject`，随后 `slot entry crashed in 'settings.plugin.item'`）：gateway 把每个 Remote 命名空间挂成**独立 cordis 服务** `remote.<ns>`，消费方读取该属性前必须在自己的 `inject` 里声明服务名；0.6.0 只声明了 `slots` / `remote` / `remote.credentials`，`settingsApi()` 里一读 `remote.settings` 属性访问本身就抛错，错误冒到 slot 边界，整张卡片被替换为错误边界。修复：`exports.inject` 补 `'remote.settings'`（核对 harness 自带 `ui-settings` 客户端同样声明 `['remote','remote.settings']`），并给该读取加 try/catch 兜底——即使服务缺失也只降级为「未挂载 settings Remote」提示，绝不再让 slot 崩溃。
- **test** `test/client-bundle.test.js` 增加两条契约防回归：`exports.inject` 必须**精确**列出卡片读取的每个 Remote 命名空间服务；settings 读取必须被 try/catch 包裹。另用真实 cordis 运行时复现/验证该机制（只注入 `remote` 复现原报错，补上 `remote.settings` 后正常解析）。

### 0.6.0（2026-09-15）

- **feat** 新增**本地代理手动配置**：设置 → 插件 → 配置 → **Jina Tools** 卡片新增「本地代理（可选）」区块，直接填代理地址（如 `http://127.0.0.1:7897`，可省略协议头）→ 保存即生效，一键清除回到自动检测。值写入插件自己的 `jina-tools` 设置命名空间的 `proxyUrl` 字段（由 settings 文档持久化，也可直接编辑 `settings.yaml`），不再只依赖自动发现。这解决的是「代理软件只监听本地端口、没有开启系统代理」的场景：WinINET 的 `ProxyEnable` 为 0，自动检测看不到它，之前的版本会直连失败。
- **feat** 代理解析优先级（`proxy.js` 纯函数，可单测）：工具级 override > 设置卡片 `proxyUrl` > 环境变量 `JINA_PROXY_URL` > WinINET 系统代理自动发现（VPN 换端口自愈保留）> 继承启动环境的 `HTTP_PROXY` / `HTTPS_PROXY`。手动配置存在时不再探测注册表；手动配置的地址在传输失败时不会被自动发现悄悄替换（错误信息会点名它，便于排查）。
- **feat** 诊断可见：`/api/dsh-jina/primer`（卡片检测区）现在返回**本次检测实际使用的代理地址与来源**，以及已保存但不可用的地址（含原因，如 `socks://` 不被 Node fetch helper 支持）；工具连接失败的错误信息会点名当前代理并给出下一步（确认端口 / 清除回自动检测 / 填写本地代理）。
- **fix** 只有 `http://` / `https://` 代理会交给网络 helper：Node 的 `fetch` 在 `NODE_USE_ENV_PROXY` 下遇到非 http(s) scheme 会直接退出，因此 `socks5://` 等地址会被明确拒绝并提示，而不是被静默忽略或让 helper 启动失败。
- **refactor** 代理策略与设置 schema 抽为纯函数模块 `proxy.js`（零依赖）；网络 helper 脚本导出为 `HTTP_HELPER_SCRIPT`，便于端到端验证。
- **test** 新增 `test/proxy.test.js`（20 例纯函数契约）、`test/plugin-proxy.test.js`（13 例 mock 宿主集成：设置注册、优先级、helper 环境变量构造、错误文案、primer 负载；含 1 例可选实时代理用例，`JINA_LIVE_PROXY=1` 时真实 spawn helper 打通 `http://127.0.0.1:7897`）、`test/client-bundle.test.js`（8 例浏览器 bundle 契约：注册 id / 命名空间 key / settings 通道 / revision 栅栏——bundle 无构建步骤，语法错误只能在运行时暴露）。
- **verify** 用真实组件逐项核对（非 mock）：把 `createSettingsSchema()` 注册进真实的 `@deepseek-ai/dsh-settings-file` 提供方，走真实 `settings.register` / `mutate` / `describe({redactSecrets:true})`（写入 `settings.yaml`、revision 递增、`secrets: []` 不按密文处理），再用真实 schemastery 3.18.2 的 `new Schema(serialized)` 重水合浏览器侧 schema（接受字符串、拒绝数字）；随后以真实设置服务驱动插件跑一次工具调用，确认写入地址出现在 helper 环境变量（大小写两套 + `NODE_USE_ENV_PROXY=1`）且不再探测注册表，清除后回到 `undefined`（完整继承 harness 环境）。另外用干净环境 + 真实 helper 脚本在独立 node 进程中实测：`HTTPS_PROXY=http://127.0.0.1:7897` + `NODE_USE_ENV_PROXY=1` → `r.jina.ai` 返回 200；换成 `127.0.0.1:1` → `fetch failed (connect ECONNREFUSED 127.0.0.1:1)`，即错误信息里点名代理地址的那条路径。
- **docs** README 新增「本地代理」章节（配置步骤、优先级、`JINA_PROXY_URL`、只在受信本机使用）；开发说明补充 proxy.js 与测试说明。

### 0.5.3（2026-09-05）

- **compat** 核对 dsh v0.1.3-alpha.1（[releases](https://github.com/deepseek-ai/deepseek-harness/releases)）：截图中的破坏性变更（Session persistence API 改为由生命周期持有的 `SessionHandle`；`agentLoop.create()` 改异步；新增 session 锁，同一 session 至多被一个进程持有；Session format 升级至 v2）均为宿主内部面——插件仅使用 `tools` / `subprocess` / `fs` / `credentials` / `webServer` / `settings` / `sandboxPolicy` 与 `exec.agent.session.header.cwd` / `exec.signal`，已逐项对照 0.1.3 源码确认无需迁移：`tools.register` 参数规范化（`normalizeRegisteredParameters`）、`output {schema, render}`、`credentials.resolve`、独立服务 `remote.credentials` 注入、`credentials/reference-updated` 事件（仍由 `remote` 转发）、`webServer.register`（exact 路由）、空命名空间 `settings.register`、keyed slot `settings.plugin.item`（`key: 'jina-tools'`）、`window.__ModuleLoader__` 注册 id（图行 id 精确包名 `dsh-jina`）、`subprocess.spawn`（`handle.done` 的 `SubprocessOutcome` + `collected` 偏移读取 + `resolveExecutable`）均未变化。同步核对 oh-my-dsh 升级卡 0.1.2-alpha.1 → rc.1（`RemoteError` 命名空间、`Session.events` 移除、`report` → `send_message`、PTC `workflow` / `web_fetch` 默认值等）：本插件均未命中，无需改动。
- **fix** 代理环境对齐 0.1.3 的出站代理策略：`subprocess` 会把 `env` 合并到已携带 harness 解析代理（启动环境的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` + `NODE_USE_ENV_PROXY`）的 scrubbed base 上；旧 `makeEnv` 每次都写 `NO_PROXY: ''` 会抹掉 base 的 bypass（含 loopback），且无条件置 `NODE_USE_ENV_PROXY=1`（SOCKS 代理下会导致 Node helper 启动失败）。修复：无发现/覆盖代理时返回 `undefined`（完整继承 harness 策略）；有代理时同时写大小写两套变量，不再碰 `NO_PROXY`，仅 http(s) 才带 flag。Windows 系统代理（WinINET 发现，含端口变化自愈）仍作为 env 策略的补充保留。
- **docs** README「网络与代理」同步说明 env 代理继承关系。

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
