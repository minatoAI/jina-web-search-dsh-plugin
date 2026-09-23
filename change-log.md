# 更新日志

本文件记录 dsh-jina 的完整版本历史；[README.md](./README.md) 的「更新日志」一节只保留最新版本。

### 0.9.0（2026-09-24）

- **feat** **多个 API key，自动轮换 + 失效自动丢弃**。Jina 账号的 credits 用完后上游返回 HTTP 402；在这个版本之前，这意味着**操作当场结束**——任务中途断掉，用户得先发现、充值、再重来。卡片现在**只有一个 key 输入框**：粘贴后点「添加」即可一直往里加，不需要管理任何单个 key。宿主把它们解析成**轮换池**：某个 key 返回 **401 / 402** 时先停用它、由下一个 key 继续服务，调用照常完成。凭据 seam 一个引用只存一个值、`describe` 视图只有 `configured`/`source`/`writable`（没有任何读取路径会回传值，所以卡片无法回读列表，「追加」只能实现为「写入第一个空槽位」），因此「多个 key」=「多个引用」；引用名只需满足 POSIX 标识符语法，已对照 harness 源码核实（`packages/credentials/credentials/src/index.ts:19` 的 `REF_PATTERN`，以及 Remote 控制器 `packages/api/settings-controller/src/credentials.ts:22-27`，单次 describe 上限 64 个引用），**无需任何 harness 改动**。
- **feat** **不能用的 key 自动丢弃**：401、402，以及卡片检测时发现**余额 ≤ 0** 的 key，由宿主半身用 `credentials.unset` 直接从凭据存储里删除，池子自我清理——所以卡片**没有「移除」按钮、也不展示任何单个 key**（无明文、无指纹、不标识正在使用哪一个）。限流（429）只临时跳过（冷却 1 分钟），网络/参数/上游故障既不轮换也不丢弃。只读环境变量遮蔽的引用（seam 拒绝写入）与 `jina-api-key.txt` 文件里的 key（插件不改写用户文件）只会被跳过，不会被删除。
- **feat** **新增纯函数模块 `keys.js`**，把池策略集中起来以便脱离 harness 单测：`KEY_REFS`（槽位表）、`parseKeyList`（每行一个 key，空行与 `#` 注释忽略、重复折叠）、`KEY_FAILOVER_STATUSES` / `isKeyFailoverStatus`（只有 401/402/429——`0`/`422`/`5xx` 不是 key 的问题，轮换只会浪费掉其余 key 的请求）、`KEY_BLOCK_MS`（401 → 30 分钟、402 → 5 分钟、429 → 1 分钟；丢弃失败时的兜底）、`keyStateAfter` / `isKeyBlocked`（成功清除状态，非轮换状态绝不把好 key 停用）、`keyRotationOrder`（粘性优先、冷却中的排到后面、全部冷却时仍按顺序尝试——如实报错胜过拒绝调用）、`keyPoolSignature`（djb2 哈希，不复制密钥本身，避免轮换状态成为第二处存密钥的地方）、`keyStatusOf` / `describeKeyStatus`、`keySourceLabel`。
- **feat** **key 文件支持多行**：`jina-api-key.txt` 现在每行一个 key（空行与 `#` 注释忽略、重复折叠），历史上「一行一个 key」的用法不变；凭据槽位的值里包含多行时也按同样规则拆开。来源优先级不变——`apiKey` 参数（单个、不轮换）→ 凭据槽位（按添加顺序）→ 会话工作区 key 文件 → dsh 主目录 key 文件——并且**第一个有 key 的来源就是本次的池**，所以凭据用户不会为文件探测付代价。每次操作都重新解析所有来源（seam 的契约），池发生变化时重置冷却状态与游标，从头重新验证。
- **feat** **页面只报 Key 总数与总额**。`/api/dsh-jina/primer` 并行探测池里每一个 key（每个 key 一个请求、不走轮换——要判断「能不能用」就必须逐个验证），只返回三个数字：**Key 总数**（`keyCount`）、**总余额**（`balanceTotal`，存活 key 的 credits 之和；无 key 报余额时为 `null`，页面显示「未知」）、**本次自动丢弃数**（`discardedCount`）——**没有任何单个 key 的信息**，也不显示「可用/总数」分数（移除 `keys[]`、`usableCount`、掩码指纹、`activeKey`、逐 key 余额与身份）。探测同时清理死 key 并写回轮换状态，所以**充值后点一次「刷新」就能让被限流的 key 回到轮换**，无需重启。`ok` / `authenticatedAs` / `balanceLeft` 仍取自**第一个可用的 key**（只用于连接状态判断，页面不展示身份与逐 key 余额）。
- **change** **切换是可见的**：中途换过 key 的成功调用会带上 `res.keySwitch`，各工具在格式化结果末尾追加一行 `[已自动切换 API key：…]`；`withKeyNote(text, res, asJson)` **绝不改动 `json: true` 的原始负载**（给 JSON 追加文字会让它无法解析）。自动丢弃的 key 会在该行里标注「已自动移除」（丢弃失败时不会谎称已移除）。整池失败时 `describeJinaError` 追加 `API key 轮换：已依次尝试 N 个 key —— …` 并提示添加 key 或充值；0.8.2 的致命状态分流不变（整池 401 抛错，402/429 返回提示）。key 查找诊断改为紧凑形式（`credential slots: none of 10 set`），避免 10 个未设置槽位淹没错误信息。
- **change** `loadKeyPool()` 取代单 key 的 `loadKey()`（后者保留为「是否存在任何 key」的薄封装，供 OCR 前置判断使用）；顺手删掉从未被调用的 `credentialKey()` 与不再使用的 `maskKey()`。整池都返回轮换状态后，宿主会**再读一次来源**（旧 401 重读的推广，覆盖「调用期间用户改了凭据或 key 文件」），并按 key 值去重，所以同一个 key 存两次也只请求一次。
- **test** 新增 `test/keys.test.js`（9 例：每个槽位都满足 Remote 的引用语法、槽位数量、key 文件解析、状态归类、冷却折叠与到期、轮换顺序含「全部冷却」与越界索引、池签名的稳定性与变化、来源标签）与 `test/multi-key.test.js`（28 例，假 Cordis 上下文并逐请求解码 helper 的 stdin：402 交给 #2 且**从凭据存储删除**该 key、401 同样丢弃、429 只跳过不丢弃、只读环境变量与 key 文件来源不被删除、粘性 key 领跑且冷却中的 key 被跳过、三 key 的 402→429→200 轮换、422/503/状态 0 停止轮换、显式 `apiKey` 不轮换、整池耗尽逐个点名、整池 401 抛错且附同样的逐 key 记录、key 文件多行回退、来源优先级「凭据优先于文件」、单槽位多行、重复 key 折叠、添加 key 下一次调用即生效、匿名路径、缺 key 文案、OCR 前置判断能看到 #2、primer 路由只返回数量与总额、余额为 0 的 key 被丢弃、限流 key 不被丢弃且刷新后恢复、空池）。`client-render.test.js` 断言**只有一个 key 输入框**、**不渲染任何单个 key**（无列表、无「移除」、无身份、无逐 key 余额）、槽位满时「添加」禁用、健康区显示「可用 Key：N 个」+「Key 总数：M 个」+「总余额」且**没有分数形式**（其 stub 现在会执行 effect 并提供 `fetch`，因此 `describe(KEY_REFS)` 可被观测）；`client-bundle.test.js` 固化「客户端槽位表必须等于 `keys.js` 的 `KEY_REFS`」、单输入表单（`keyDraft` 字符串 + `firstFreeRef` + 添加，卡片自身不调用 `unset`）与「设置写入路径仍然只有一条」。全套 **160 例：159 通过 / 1 例（`JINA_LIVE_PROXY`）按需跳过 / 0 失败**。
- **verify** 对照 harness 源码核实 seam 契约：`credentials.describe(refs)` 返回 `Record<string, CredentialInfo>`，没有承载值的字段、也没有引用枚举接口；`set(ref, value)` 拒绝空值、接受任意非空字符串；`unset` 对启动环境变量遮蔽的引用会抛错（被 `discardKey` 吞掉并退回冷却机制）；拒绝以 `RemoteError('credential/rejected', …)` 返回，卡片**原样显示** seam 的消息。`ui/client.js` 的 `KEY_REFS` 由测试钉死等于 `keys.js` 的表——因为凭据命名空间没有枚举接口，卡片只能描述自己写下的引用名；也正因如此，追加语义只能实现为「写入第一个空槽位」。

### 0.8.2（2026-09-23）

- **fix** **收口错误传播的最后两处不一致**（0.8.0 已记录为「暂未改动」）：`jina_read` / `jina_screenshot` / `jina_datetime` 的 URL 校验此前是**返回字符串** `'invalid url: undefined (must start with http:// or https://)'`，实测确认为 **`isError: false`** —— 模型可能把这条消息当数据读。根因是该行是**本地正则前置校验**，位于 `callJina` 之前、**从未发出网络请求**，因此与上游错误码无关。现抽出 `requireUrlArg()`（逐行复刻 `requireStringArg` 的契约与文案格式，复用 `argAt` / `argsReceived`）并改为**抛错**，同时把校验上移到 `enterExec` 之前，与 `runSearch` 的「校验先于一切副作用」对齐；仍为零请求。顺带修掉旧文案 `'invalid url: ' + args.url` 遇对象打印 `[object Object]` 的诊断缺陷——现在报 `(number) 42` / `(string) "example.com"`，并在键名疑似笔误时给出 `did you mean "url" instead of "uri"?`（别名表 `['uri','link','href']` 只用于提示，不参与取值，与 `requireStringArg` 的 `['queries','q']` 同语义）。
- **fix** `jina_read` 的 **OCR 无 key** 路径同样由「返回字符串」改为**抛错**（文案一字不改）。0.8.0 把它写成「直接返回可操作的提示」，但它是**前置拒绝**、不是 API 响应，返回形态会让模型把它当结果；改为抛错后 harness 标记 `isError: true`，而「检测不到 key 就不发请求」的承诺不变。
- **change** **上游错误按状态码分流**：新增 `failJina(res)` 与 `FATAL_JINA_STATUSES = {401, 422}` —— `401`（key 无效/缺失）与 `422`（参数非法）**抛错**，因为模型必须改 key 或改参数；`0`（网络/代理）、`402`（额度）、`429`（限流）、`5xx` **保持返回**，因为其提示是给模型转述给用户或稍后重试的，不应诱导模型去改自己的参数。9 处 `if (!res.ok) return describeJinaError(res)` 改为 `return failJina(res)`（其中 `runSearch` 那处缩进为 4 空格，逐处核对过）。**`jina_primer`（`error: describeJinaError(out)`）刻意不改**——它组装的是 JSON 负载，且工具描述明确承诺「the tool never throws」。`callJina` 的 401 刷新重试在状态判定之前完成，因此不会误伤「key 轮换后成功」的路径。
- **test** `test/tool-args.test.js` 追加 10 例（`createHost(reply)` 现可注入任意 helper 回复，新增 `envelope()` / `readerBody()`）：三个 URL 工具的缺失 / 无协议 / 错误类型 / 键名笔误四种拒绝形态（均断言 `helpers.length === 0`）、合法 URL 仍照发请求且 `body.url` 原样的正向用例（用 400 字符正文避开选择器重试，锁死 `helpers.length === 1`）、OCR 无 key 仍零请求，以及 401 抛错 / 422 抛错 / 429 返回 / `jina_primer` 永不抛错四条分流回归线。同步把 `test/reader-headers.test.js` 的「OCR 无 key」旧断言从「返回字符串」改为断言抛错（该文件原断言依赖旧形态）。全套 **114 例：113 通过 / 1 例（`JINA_LIVE_PROXY`）按需跳过 / 0 失败**。
- **verify** 静态核对：`grep -n "return failJina(res)" index.js` = 9 行、`grep -n "describeJinaError" index.js` 仅剩定义、`failJina` 内部调用与 `jina_primer` 的负载组装（`error: describeJinaError(out)`）三处、`grep -n "return 'invalid url" index.js` = 0 行；改动前 `test/` 下对 `401` / `422` / `invalid url` / `describeJinaError` **零覆盖**，故改动 C 无旧断言需要迁移（唯一需要改的是改动 B 命中的 OCR 那条）。

### 0.8.1（2026-09-23）

- **fix** **修复新版 harness 上设置卡片的「阅读工具选项」全部变灰、两个保存按钮点不动**（用户实测截图）：dsh `601d6761e4`（`feat(settings): project volatile Config through profile-backed forms`）**删除了 `settings.register(ns, schema)`**，设置命名空间从此就是 **Loader/profile 组合条目的 id**；插件改为导出 schemastery 形态的 `Config`，harness 经 Standard Schema 的 `'~standard'.validate` 解析后，把结果作为 `apply(ctx, config)` 的第二个参数交给插件。旧代码在 `ctx.inject(['settings'], …)` 里调用 `sctx.settings.register(...)`，抛 `TypeError: sctx.settings.register is not a function`；异常被插件的 try/catch 吞掉，于是 `jina-tools` 命名空间从未出现在 `settings.describe()` 的 `namespaces` 里，浏览器半身 `loadProxy()` 找不到对应行 → `phase = 'unavailable'` → 所有控件 `disabled`（`optsReady = phase === 'ready' && writable`）。截图里的"不能调整"是这个症状，**不是 CSS / 权限 / 只读 profile 问题**；同一根因也让 `settings.yaml` 里的改动无论如何都存不进去。
- **fix** **保存即时生效，不重启、不重挂载**：新机制要求字段节点带 `meta.volatile`，解析结果里每个字段是**跨副本安全**的 volatile 引用（`Symbol.for('cosmokit.volatile.write')`，与 harness 自带 `cosmokit` 用同一个 Symbol）。保存时 harness 只把新值写进这些引用（`updateVolatile`），`fiber.config` 的对象身份不变、插件不重挂载，插件每次操作重新 `settingsSnapshot(config)` 读取——与 API key 完全相同的"每次调用重新解析"契约。
- **fix** 根节点**不能**整体标 `meta.volatile`：`volatileForm()` 会把整段配置当成一个引用，`strip()` 于是丢掉文档里所有非字段键（未来版本的字段、手改的内容）。采用逐字段 `meta.volatile` 后，未声明的键会原样保留（已由回归测试固化）。
- **fix** `Config['~standard'].validate` 必须**同步**返回**纯对象**：`resolveConfig()` 遇到 thenable 直接抛 `TypeError('Async config validation is not supported')`，返回 `issues` 则抛 cordis `ValidationError`；`volatileEntries()` 也只递归纯对象（`Object.getPrototypeOf === Object.prototype`），否则整个设置通道静默失效。校验器对 `undefined` / 非对象 / 手改脏值一律容错（始终返回 8 个引用，值原样交给 `toolSettingsOf()` 归一化），避免任何一个 profile 组合让 `describe()` 抛错——`describe()` 是**整个 Plugins 设置页共用**的，抛错会波及所有插件的配置卡。
- **fix** `Config.toJSON()` 每次必须返回**新节点**：`plainSchema()` 会 walk 一遍并 `delete node.meta.volatile`，复用同一份 dict 会让后续保存全部退化成"整插件重挂载"。同时每个字段节点都要自带 `toJSON()` 与 `meta`（schemastery 的 string resolver 会解引用 `meta.loose`）。
- **change** 宿主半身不再 `inject(['settings'])`；`/api/dsh-jina/primer` 的 `settingsError` 字段改为 `settingsLive`（布尔健康检查：解析结果是否真的持有 volatile 引用），卡片"检测"区据此说明设置通道是否可用。
- **test** `test/proxy.test.js` / `test/reader-headers.test.js` / `test/plugin-proxy.test.js` / `test/tool-args.test.js` 全部迁移到新 seam（`Config['~standard'].validate(raw).value` → `apply(ctx, config)`），并新增断言：8 个字段都带 `meta.volatile` 且能穿过 `toJSON()`、`validate` 的容错面、`toJSON()` 每次新节点，以及两条端到端回归——**卡片保存的阅读选项与代理地址在下一次工具调用就生效，无需重启**（代理那条还断言保存后不再探测 WinINET 注册表）。全套 104 例：103 通过 / 1 例（`JINA_LIVE_PROXY`）按需跳过。
- **verify** 用**真实**组件（非 mock）逐项核对：`packages/settings/settings/lib/index.js`（包 `main`，即运行中的服务加载的那份）的 `SettingsForms.describe()/mutate()`、`lib/types/schema.js` 的 `plainConfig`/`volatileForm`/`projectForm`/`isVolatilePath`、`cordis-plugin-loader/lib/types/config/diff.js` 的 `equalExceptVolatile`，以及 profile 里 `@deepseek-ai/cosmokit` 的 `volatileEntries`/`updateVolatile`/`deepEqual`，用一个忠实的 `configEditor` 替身复刻 `resolveConfig` 后跑通：8 条 volatile 引用落在正确路径、`volatileForm(Config)` 非空、`projectForm(form, plainConfig(resolved))` 恒等、`describe()` 反复调用不会剥掉 `meta.volatile`、完整 `describe() → mutate()` 往返（`applies: 'live'`、revision 栅栏、`base`/`user`/`value` 分层、`unset` 回落到继承值、过期 revision 抛 `SettingsConflictError`、非 volatile 路径被拒）、`equalExceptVolatile(fiber.config, candidate, Config) === true`（证明走的是**热更新**而非重挂载）。

### 0.8.0（2026-09-18）

- **feat** **`jina_read` 新增 OCR 开关（jina-ocr-v1）**：`ocr: true`（或在卡片里设为默认）后改走 `X-Respond-With: jina-ocr-v1`——官方 3.4B 文档解析模型，一次过把扫描件 / 图片型 PDF / 复杂表格与公式转成 Markdown（表格出 HTML、公式出 LaTeX），支持中英文。多页文档用 `page` 参数（`X-Page`）指定单页。该模型约 **40× token**，且**官方对匿名请求直接 401**（实测：`Authentication is required to use this feature (Vision Language Model / OCR)`），因此本插件在检测不到 key 时**不发请求**，直接返回可操作的提示（保存 key 或传 `apiKey`）。
- **feat** **每次读取固定发送三个零副作用参数**（依据官方 OpenAPI 与参数面板逐项核对）：`X-Preset: agent`（官方为 AI agent 预调的预设；官方文档明确 preset **只填充调用方未显式设置的选项**，因此不会覆盖任何显式参数）、`X-Base: final`（用重定向后的最终 URL 解析相对链接，修"跳转后链接全错"）、`X-Timeout: 120`（与客户端自己的 120s 上限对齐；发官方上限 180 没有意义——客户端会先超时并报自己的错误，要改就两边一起改）。
- **feat** **选择器组默认开启 + 空结果自动回退**：默认发送保守的 `X-Target-Selector`（只含 `article` / `main` / `[role="main"]` / `.markdown-body` 一类正文容器）与 `X-Remove-Selector`（页眉页脚、导航、cookie 横幅、广告、侧栏、评论等），并新增调用级参数 `targetSelector` / `waitForSelector` / `removeSelector` / `noCache`。`X-Target-Selector` 会**隐含**同值的 `X-Wait-For-Selector`，选择器不命中会返回空页——因此当首次结果不足 200 字符时会**自动去掉选择器组重试一次**，并保留更长的那份（`SELECTOR_RETRY_MIN_CHARS`）。排除列表刻意不含 `.modal` / `.popup` / `.overlay` 这类"可能就是内容容器"的选择器。
- **feat** **图片策略可配**：`X-Retain-Images` 不再硬编码 `none`，默认回到官方默认值 `all`（可选 `alt` / `none`）；`images` / `links` 参数继续追加图片/链接清单。
- **feat** **设置卡片新增「阅读工具选项」区块**：OCR 开关、图片保留策略下拉、alt 文本生成开关、选择器组开关，以及正文/排除选择器的覆盖输入框。全部字段与 `proxyUrl` 同属 `jina-tools` 命名空间，并走**同一条 revision 栅栏写入路径**（`mutate(NS, ops, proxyView.revision)`），两个区块不会互相覆盖。
- **fix** **`X-With-Generated-Alt` 默认关闭**：它是付费功能（匿名请求同样 401：`Authentication is required to use this feature (Alt text generation)`），且**与 `X-Respond-With` 互斥**（官方文档：指定 `X-Respond-With` 时 alt 生成不生效）。更关键的是——**只有带上 key 的请求才计费**，若默认开启，任何已配置 key 的用户会从"匿名免费读取"静默变成"计费读取"。因此该项需显式开启，且只在非 OCR 路径 + 有 key 时发送。
- **fix** **`createSettingsSchema()` 此前只保留 `proxyUrl` 一个字段**，新增字段会被静默丢弃、设置根本存不进去。现改为保留全部已知字段（类型校验 + 未知字段丢弃），并新增 `toolSettingsOf()` 把"未设置"解析为默认值。设置文档仍**只存偏离默认值的部分**，因此以后调整默认值能覆盖到从未改过该字段的用户（现有 `settings.yaml` 里只有 `proxyUrl` 的用户不受影响）。
- **fix** **必填参数不再被静默转成字符串 `"undefined"`**（用户实测缺陷）：`ctx.tools.register` 只把 `parameters` 交给模型 API，**运行期从不校验**（校验只存在于一方 `defineTool` 路径），因此模型把键名写错时原样落到执行体里；`String(args.query)` 会把缺失的 `query` 变成四个字符的搜索词 `undefined`，Jina 于是返回 MDN 的 `undefined` 词条——**格式完好、`isError: false`**，看起来就像一次真实检索。实测现场：模型用 `jina_web_search` 发的是 `{"queries":[...],"num":6}`（内置 `web_search` 用 `queries`、本插件用 `query`，两个工具同时注册，模型把两者习惯合并了）。现为 `jina_web_search` / `jina_search_arxiv` / `jina_search_ssrn` / `jina_expand` / `jina_rerank` 的 `query`、`jina_embed` / `jina_classify` 的 `texts`（与 `labels`）、`jina_rerank` 的 `documents`、`jina_pdf` 的 `url`/`arxivId` 二选一加了前置校验：**直接抛错**（harness 会转成 `isError: true` 并加 `Error:` 前缀——只有这个形态能让模型停下来改参数，返回错误字符串仍会被当作成功结果），报错点名工具名、参数名、期望类型、实际收到的键列表，并在键名疑似笔误时给出提示（如 `did you mean "query" instead of "queries"`）；校验发生在 `enterExec` 与 `callJina` 之前，**不发出任何网络请求**。已知仍存的不一致：`jina_read` / `jina_screenshot` / `jina_datetime` 的 URL 校验仍是「返回字符串」，不会产生看似正确的假结果，暂未改动。
- **change** `jina_read` 现在固定用 `Accept: application/json` 请求，并把 JSON 信封解包成 markdown 返回：带上 `Title` / `URL Source` / `Published Time` 头部与 `[Usage: ...]` 尾注；不可解析的响应**原文返回**，绝不丢正文。
- **test** 新增 `test/reader-headers.test.js`（14 例）：解码网络 helper 的 stdin，逐条断言**真实发出的请求头**——固定三项、图片策略、选择器组与重试、OCR 开关与 `X-Page`、无 key 时零请求、alt 的 opt-in / 需 key / 与 OCR 互斥三重约束、JSON 信封解包与 usage、不可解析响应兜底、schema 字段保留与 `toolSettingsOf` 默认值。`test/client-render.test.js` 增加选项控件渲染断言（3 个 checkbox + 图片策略下拉 + 两个选择器输入框），`test/client-bundle.test.js` 增加字段接线与"只有一条写入路径"断言。另新增 `test/tool-args.test.js`（9 例）：以**实测现场的那次错误调用**（`{queries:[...],num:6}`）为第一条断言，覆盖缺失 / 空串 / 纯空白 / 错误类型 / `undefined` 实参，断言报错文案点名参数与疑似笔误、断言 `helpers.length === 0`（被拒的调用不得发出请求），并用一条正向用例锁住合法 `query` 仍原样送到 API（`body.q`）。

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
