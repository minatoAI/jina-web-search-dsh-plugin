// dsh-jina — browser bundle (prebuilt; no build step required).
//
// Executing this script only REGISTERS its factory with the client module
// system (`window.__ModuleLoader__.load`). The registration id MUST equal the
// boot-graph row id — the exact package name `dsh-jina` (the host's
// client-modules scan keys rows by package name; the runtime normalizes a
// trailing `/client` only, never a subpath). A subpath id (e.g. the historical
// `dsh-jina/ui`) registers a key nobody asks for, and the module system
// reports `loaded without registering "dsh-jina"`. The factory materializes on
// first import and returns a cordis client plugin that contributes the
// configuration form for the `dsh-jina` bundle to the Plugins page
// (sidebar → Plugins → the dsh-jina bundle), through the
// `plugins.bundle.config` KEYED slot declared by the web plugin-manager
// package — keyed by the bundle's package name, so the registration uses
// `key: 'dsh-jina'`. The page draws the title, icon, and crumb, and asks the
// entry for one of two views: `summary` (the one-liner under the title) and
// `page` (the form with its own save control).
//
// A harness whose Plugins page predates that slot declares only the older
// `settings.plugin.item` KEYED slot (Settings → Plugins → Configure, keyed by
// the settings namespace the card edits, so `key: 'jina-tools'` — the
// namespace the host half (index.js) serves). The same card registers there
// too, so one bundle configures on either surface; `slots.inject` waits for
// whichever declarer exists. Drop that arm once no supported harness declares
// it.
//
// The card manages the API key pool through the standard credentials Remote
// namespace: `remote.credentials` (the generated `$mount` installs it as its
// own `remote.credentials` cordis service — inject it, do not reach through the
// `remote` object) with describe/set/unset. One key per credential reference,
// because the seam stores one value per reference and its `describe` view
// carries `configured`/`source`/`writable` only — a value is never read back.
// The references are the pool KEY_REFS (index.js/keys.js must agree): slot 1 is
// the reference the single-key card of 0.8.x wrote, the rest are the free slots
// the card fills in order. The form is therefore ONE input plus an "add"
// control that writes into the first free slot — no list, no per-key row and no
// remove control: the host discards a key that is exhausted (401/402, or a
// probe reporting no credits left) on its own, so the user only ever adds keys.
// The card reports how many keys are usable, how many it holds, and the total
// credits behind them; it never identifies an individual key. Values cross the
// wire only on save. It refreshes when the Host reports a reference changed
// (`credentials/reference-updated`, observed on the `remote` service itself).
//
// It also owns the plugin's `jina-tools` settings namespace through the
// standard settings Remote namespace (`remote.settings`, mounted by the same
// api-remotes client plugin): the `proxyUrl` field carries a manually
// configured local proxy address. That is the entry point for a proxy client
// which listens on a loopback port WITHOUT being the Windows system proxy —
// WinINET discovery cannot see it, and neither can the harness environment, so
// without this field every Jina call would go direct and fail. Reads ride
// `settings.describe`, writes `settings.mutate` fenced by the namespace
// revision the page read, and external edits (another tab, a hand-edited
// settings.yaml) arrive as `settings/document-updated` and reload the card.
//
// It also runs the key health check: a GET to the host-provided
// `/api/dsh-jina/primer` route (registered by the bundle's host half when a
// web server is composed), which answers with the key's Jina identity and
// credit balance — the same data `jina_primer` reports — and with the proxy the
// probe actually ran through. The key itself never leaves the host.
window.__ModuleLoader__.load({
  id: 'dsh-jina',
  factory: function (require) {
    var React = require('react')
    var exports = {}
    // The key pool, in slot order. MUST stay in lockstep with keys.js KEY_REFS:
    // slot 1 (`JINA_API_KEY`) is the reference 0.8.x wrote, the rest are the
    // free slots the "add" control fills in order. The credentials Remote
    // namespace has no enumeration, so the card can only describe references it
    // names itself.
    var KEY_REFS = [
      'JINA_API_KEY', 'JINA_API_KEY_2', 'JINA_API_KEY_3', 'JINA_API_KEY_4', 'JINA_API_KEY_5',
      'JINA_API_KEY_6', 'JINA_API_KEY_7', 'JINA_API_KEY_8', 'JINA_API_KEY_9', 'JINA_API_KEY_10',
    ]
    var NS = 'jina-tools'
    var PROXY_FIELD = 'proxyUrl'
    // Reader-policy fields of the same `jina-tools` namespace. The host owns
    // the defaults (proxy.js `toolSettingsOf`), so the card only ever writes
    // deviations: `set` for opt-in flags, `unset` to fall back to a default.
    var IMAGE_POLICY_FIELD = 'imagePolicy'
    var AUTO_ALT_FIELD = 'autoAltText'
    var SELECTORS_FIELD = 'useSelectors'
    var TARGET_SELECTOR_FIELD = 'targetSelector'
    var REMOVE_SELECTOR_FIELD = 'removeSelector'
    var IMAGE_POLICIES = ['all', 'alt', 'none']
    // Host-reported proxy source → the label the card shows.
    var PROXY_SOURCES = {
      setting: '设置卡片',
      envVar: '环境变量 JINA_PROXY_URL',
      system: 'Windows 系统代理（自动发现）',
      environment: '启动环境变量（HTTP_PROXY 等）',
      request: '调用级指定',
      none: '无（直连）',
    }
    // Host-reported rejection reason code → the label the card shows.
    var PROXY_REJECTS = {
      scheme: '只支持 http:// 或 https:// 代理',
      invalid: '地址格式不正确',
      empty: '地址为空',
      type: '地址不是字符串',
    }

    var S = {
      card: { boxSizing: 'border-box', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 16, boxShadow: 'var(--dsw-shadow-lv3)', overflow: 'hidden', margin: 0, listStyle: 'none' },
      header: { boxSizing: 'border-box', width: '100%', display: 'flex', alignItems: 'center', gap: 12, border: 'none', background: 'transparent', cursor: 'pointer', padding: '14px 18px', fontFamily: 'inherit', textAlign: 'left', color: 'inherit' },
      headText: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
      name: { fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)', lineHeight: '22px', margin: 0 },
      description: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.92))', margin: 0 },
      chevron: { flex: 'none', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.92))', transition: 'transform .15s ease', display: 'block' },
      body: { boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12, padding: '0 18px 16px' },
      row: { display: 'flex', gap: 8, alignItems: 'center' },
      input: { boxSizing: 'border-box', flex: 1, minWidth: 0, height: 36, borderRadius: 10, border: '1px solid rgba(127,127,127,0.35)', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'var(--dsw-alias-label-primary)', padding: '0 12px', fontSize: 13, fontFamily: 'inherit', outline: 'none' },
      button: { boxSizing: 'border-box', height: 36, borderRadius: 10, border: 'none', padding: '0 18px', cursor: 'pointer', fontSize: 13, fontWeight: 500, background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit' },
      ghostButton: { boxSizing: 'border-box', height: 36, borderRadius: 10, border: '1px solid rgba(127,127,127,0.35)', padding: '0 18px', cursor: 'pointer', fontSize: 13, fontWeight: 500, background: 'transparent', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.92))', fontFamily: 'inherit' },
      smallButton: { boxSizing: 'border-box', height: 26, borderRadius: 8, border: '1px solid rgba(127,127,127,0.35)', padding: '0 10px', cursor: 'pointer', fontSize: 12, fontWeight: 500, background: 'transparent', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.92))', fontFamily: 'inherit' },
      infoBox: { boxSizing: 'border-box', border: '1px solid rgba(127,127,127,0.25)', borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 },
      infoHead: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
      infoLabel: { fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-primary)', margin: 0 },
      status: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.92))', margin: 0 },
      statusOk: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-status-success, #2f9e44)', margin: 0 },
      statusBad: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-status-danger, #e03131)', margin: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)', margin: 0, wordBreak: 'break-all' },
      note: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.6))', margin: 0 },
      link: { color: 'var(--dsw-alias-label-link, var(--dsw-alias-label-primary))', textDecoration: 'underline', cursor: 'pointer' },
      checkRow: { display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' },
      checkLabel: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)', flex: 1 },
      select: { boxSizing: 'border-box', height: 32, borderRadius: 8, border: '1px solid rgba(127,127,127,0.35)', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'var(--dsw-alias-label-primary)', padding: '0 8px', fontSize: 12, fontFamily: 'inherit' },
    }

    function Chevron(props) {
      return React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true,
        style: Object.assign({}, S.chevron, props.open ? { transform: 'rotate(180deg)' } : null),
      },
        React.createElement('path', {
          d: 'M3.5 5.5L7 9l3.5-3.5', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    function JinaCard(props) {
      var remote = props.remote
      var credentials = props.credentials
      var [open, setOpen] = React.useState(false)
      // ---- API key pool -----------------------------------------------------
      // The page never sees a value: `keyViews` is the describe view of every
      // slot, `keyDraft` is the one input the user is typing into (never seeded
      // from the host), `keyStatus` is the feedback of the last add/remove.
      // Slot 1 is the reference 0.8.x wrote; a new key goes into the first free
      // slot.
      var [keyViews, setKeyViews] = React.useState(undefined) // Record<ref, {configured, source, writable}> | undefined while loading
      var [keyDraft, setKeyDraft] = React.useState('')
      var [keyStatus, setKeyStatus] = React.useState({ kind: 'info', message: '' })
      var [primer, setPrimer] = React.useState({ phase: 'loading', data: undefined, error: undefined })
      // ---- manual local proxy ---------------------------------------------
      // `proxyView` mirrors the host's `jina-tools` namespace: phase 'ready'
      // carries the stored address, the revision the next write is fenced
      // against, and whether the document accepts writes at all.
      var [proxyView, setProxyView] = React.useState({ phase: 'loading', url: '', revision: undefined, writable: false, error: '', options: undefined })
      var [proxyInput, setProxyInput] = React.useState('')
      var [proxyStatus, setProxyStatus] = React.useState('')
      var [proxyStatusKind, setProxyStatusKind] = React.useState('info')
      var proxyDirty = React.useRef(false)
      // ---- reader options (same namespace, same revision-fenced write path) --
      // NOTE: every hook is declared before any early return below; the state
      // order is load-bearing for `test/client-render.test.js`, which renders
      // by overriding the first `useState` (the collapsible `open` flag).
      var [imagePolicyInput, setImagePolicyInput] = React.useState('all')
      var [autoAltInput, setAutoAltInput] = React.useState(false)
      var [selectorsInput, setSelectorsInput] = React.useState(true)
      var [targetSelectorInput, setTargetSelectorInput] = React.useState('')
      var [removeSelectorInput, setRemoveSelectorInput] = React.useState('')
      var [optsStatus, setOptsStatus] = React.useState('')
      var [optsStatusKind, setOptsStatusKind] = React.useState('info')
      var optsDirty = React.useRef(false)

      var settingsApi = function () {
        // `remote.settings` is its own cordis service (the gateway mounts every
        // Remote namespace as `remote.<ns>`): reading it requires the consumer
        // to declare that service in `inject`, and a missing declaration throws
        // from the property access itself. The declaration below is the fix;
        // this guard keeps a surprise from crashing the whole slot entry.
        try {
          return remote && remote.settings ? remote.settings : undefined
        } catch (err) {
          return undefined
        }
      }

      var refresh = function () {
        if (credentials === undefined) {
          // No credential plane at all (a profile without a credential
          // provider): every slot reads as unconfigured and disabled instead of
          // loading forever. The host still resolves the key file.
          setKeyViews({})
          return
        }
        credentials.describe(KEY_REFS).then(function (response) {
          if (!response || response.ok !== true) return
          setKeyViews(response.value || {})
        }, function () { /* keep previous view */ })
      }

      var loadPrimer = function () {
        setPrimer({ phase: 'loading', data: undefined, error: undefined })
        fetch('/api/dsh-jina/primer').then(function (r) { return r.json() }).then(function (payload) {
          if (payload && payload.ok === true) setPrimer({ phase: 'ok', data: payload, error: undefined })
          else setPrimer({ phase: 'error', data: undefined, error: (payload && payload.error) || 'HTTP ' + (payload && payload.status) })
        }, function (err) {
          setPrimer({ phase: 'error', data: undefined, error: String((err && err.message) || err) })
        })
      }

      /** Adopt one settings namespace view (describe row or mutate answer). */
      var adoptProxy = function (row, writable) {
        var value = row && row.value && typeof row.value === 'object' ? row.value : {}
        var url = typeof value[PROXY_FIELD] === 'string' ? value[PROXY_FIELD] : ''
        var options = {
          imagePolicy: IMAGE_POLICIES.indexOf(value[IMAGE_POLICY_FIELD]) >= 0 ? value[IMAGE_POLICY_FIELD] : 'all',
          autoAlt: value[AUTO_ALT_FIELD] === true,
          selectors: value[SELECTORS_FIELD] !== false,
          targetSelector: typeof value[TARGET_SELECTOR_FIELD] === 'string' ? value[TARGET_SELECTOR_FIELD] : '',
          removeSelector: typeof value[REMOVE_SELECTOR_FIELD] === 'string' ? value[REMOVE_SELECTOR_FIELD] : '',
        }
        setProxyView({
          phase: 'ready',
          url: url,
          revision: row ? row.revision : undefined,
          writable: writable === true,
          error: '',
          options: options,
        })
        // An unsaved edit is never clobbered by a refresh; a field the user
        // never touched follows the document (another tab, settings.yaml).
        if (!proxyDirty.current) setProxyInput(url)
        if (!optsDirty.current) {
          setImagePolicyInput(options.imagePolicy)
          setAutoAltInput(options.autoAlt)
          setSelectorsInput(options.selectors)
          setTargetSelectorInput(options.targetSelector)
          setRemoveSelectorInput(options.removeSelector)
        }
        return url
      }

      var loadProxy = function () {
        var api = settingsApi()
        if (api === undefined || typeof api.describe !== 'function') {
          setProxyView({ phase: 'unavailable', url: '', revision: undefined, writable: false, error: '当前环境未挂载 settings Remote，无法在此配置本地代理；可改用环境变量 JINA_PROXY_URL。' })
          return
        }
        api.describe().then(function (response) {
          if (!response || response.ok !== true) {
            var message = (response && response.error && response.error.message) || 'settings.describe 失败'
            setProxyView({ phase: 'unavailable', url: '', revision: undefined, writable: false, error: message })
            return
          }
          var doc = response.value || {}
          var rows = Array.isArray(doc.namespaces) ? doc.namespaces : []
          var row = rows.filter(function (entry) { return entry && entry.ns === NS })[0]
          if (row === undefined) {
            setProxyView({ phase: 'unavailable', url: '', revision: undefined, writable: doc.writable === true, error: '主机未提供 ' + NS + ' 设置命名空间（当前 profile 可能没有 settings 提供方）。' })
            return
          }
          adoptProxy(row, doc.writable === true)
        }, function (err) {
          setProxyView({ phase: 'unavailable', url: '', revision: undefined, writable: false, error: String((err && err.message) || err) })
        })
      }

      /**
       * Write operations into the namespace, fenced by the revision the card
       * read. One writer serves both blocks (proxy + reader options) so the
       * revision can never drift between them; `report` lets a block render its
       * own status line while sharing the same write.
       */
      var writeProxy = function (ops, okMessage, report) {
        var say = report || function (kind, message) { setProxyStatusKind(kind); setProxyStatus(message) }
        var api = settingsApi()
        if (api === undefined || typeof api.mutate !== 'function') {
          say('bad', '当前环境未挂载 settings Remote，无法保存。')
          return
        }
        if (proxyView.phase !== 'ready') {
          say('bad', '设置尚未加载完成，请稍后重试。')
          return
        }
        if (!proxyView.writable) {
          say('bad', '当前环境只读（设置文档不可写），无法在此保存。')
          return
        }
        say('info', '保存中…')
        api.mutate(NS, ops, proxyView.revision).then(function (response) {
          if (response && response.ok === true) {
            adoptProxy(response.value, proxyView.writable)
            say('ok', okMessage)
            loadPrimer()
          } else {
            var message = (response && response.error && response.error.message) || '未知错误'
            say('bad', '保存失败：' + message + '（已重新读取当前设置，请重试）')
            proxyDirty.current = false
            optsDirty.current = false
            loadProxy()
          }
        }, function () {
          say('bad', '保存失败，请重试。')
        })
      }

      React.useEffect(function () {
        refresh()
        loadProxy()
        loadPrimer()
        var disposers = [
          remote.$on('credentials/reference-updated', function (ref) {
            // Any pool slot: a key saved in another tab, or cleared by a
            // hand-edited .credentials.yaml, changes the rotation too.
            if (ref === undefined || KEY_REFS.indexOf(ref) >= 0) {
              refresh()
              loadPrimer()
            }
          }),
          remote.$on('settings/document-updated', function (ns) {
            // Our own write answers already carry the new view; this covers
            // edits from another tab or a hand-edited settings.yaml.
            if (ns === undefined || ns === NS) loadProxy()
          }),
        ]
        return function () {
          for (var i = 0; i < disposers.length; i++) if (typeof disposers[i] === 'function') disposers[i]()
        }
      }, [remote])

      /** Add/remove feedback for the one key form. */
      function say(kind, message) {
        setKeyStatus({ kind: kind, message: message })
      }

      function onKeyInput(e) {
        setKeyDraft(e.target.value)
      }

      /** The first slot the user has not filled yet, or undefined when the pool is full. */
      function firstFreeRef() {
        for (var i = 0; i < KEY_REFS.length; i++) {
          if (!keyViewOf(KEY_REFS[i]).configured) return KEY_REFS[i]
        }
        return undefined
      }

      function onAdd() {
        var value = keyDraft.trim()
        if (value === '') {
          say('bad', '请输入 API key。')
          return
        }
        if (credentials === undefined) {
          say('bad', '当前环境未挂载凭据控制面（credentials Remote），无法保存。')
          return
        }
        var ref = firstFreeRef()
        if (ref === undefined) {
          say('bad', '槽位已满（最多 ' + KEY_REFS.length + ' 个 key）；失效或额度耗尽的 key 会被自动丢弃，之后即可继续添加。')
          return
        }
        say('info', '保存中…')
        credentials.set(ref, value).then(function (response) {
          if (response && response.ok === true) {
            say('ok', '已保存。')
            setKeyDraft('')
            refresh()
            loadPrimer()
          } else {
            // A read-only source shadowing the reference (an environment
            // variable) is the seam's own message and must be shown verbatim.
            say('bad', '保存失败：' + String((response && response.error && response.error.message) || '未知错误'))
          }
        }, function () {
          say('bad', '保存失败，请重试。')
        })
      }

      /** The describe view of one slot; the seam answers unknown refs as unwritable-free blanks. */
      function keyViewOf(ref) {
        var info = keyViews && keyViews[ref] ? keyViews[ref] : undefined
        return {
          configured: info ? info.configured === true : false,
          source: info && typeof info.source === 'string' ? info.source : '',
          writable: info ? info.writable === true : false,
        }
      }

      var keyCount = 0
      for (var ki = 0; ki < KEY_REFS.length; ki++) if (keyViewOf(KEY_REFS[ki]).configured) keyCount++
      var keysLoading = keyViews === undefined
      var credentialsMissing = credentials === undefined
      var keyFull = !keysLoading && firstFreeRef() === undefined
      // The host's probe knows the whole pool, including keys that come from a
      // jina-api-key.txt file and therefore have no slot on this card. Prefer it
      // for "is anything configured at all", fall back to the slots.
      var poolCount = primer.data && typeof primer.data.keyCount === 'number' ? primer.data.keyCount : keyCount
      var keyStatusStyle = keyStatus.kind === 'ok' ? S.statusOk : (keyStatus.kind === 'bad' ? S.statusBad : S.status)
      var proxyStatusStyle = proxyStatusKind === 'ok' ? S.statusOk : (proxyStatusKind === 'bad' ? S.statusBad : S.status)

      // ---- manual proxy block -----------------------------------------------
      function onProxyInput(e) {
        proxyDirty.current = true
        setProxyInput(e.target.value)
      }

      function onProxySave() {
        var value = proxyInput.trim()
        if (value === '') {
          setProxyStatusKind('bad')
          setProxyStatus('请输入本地代理地址，例如 http://127.0.0.1:7897。')
          return
        }
        var scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)
        if (scheme !== null && scheme[1].toLowerCase() !== 'http' && scheme[1].toLowerCase() !== 'https') {
          setProxyStatusKind('bad')
          setProxyStatus('只支持 http:// 或 https:// 代理（例如 http://127.0.0.1:7897）。socks:// 不会被网络 helper 使用。')
          return
        }
        if (scheme === null && !/^[^\s/]+:\d+$/.test(value)) {
          setProxyStatusKind('bad')
          setProxyStatus('请填写「主机:端口」（例如 127.0.0.1:7897）或完整地址（例如 http://127.0.0.1:7897）。')
          return
        }
        proxyDirty.current = false
        writeProxy([{ op: 'set', path: [PROXY_FIELD], value: value }], '已保存，下一次调用立即生效。')
      }

      function onProxyClear() {
        proxyDirty.current = false
        writeProxy([{ op: 'unset', path: [PROXY_FIELD] }], '已清除，回到自动检测（系统代理 / 环境变量）。')
      }

      var proxyConfigured = proxyView.url !== ''
      var proxyShown
      if (proxyView.phase === 'loading') proxyShown = '正在读取设置…'
      else if (proxyView.phase === 'unavailable') proxyShown = proxyView.error + ' 自动检测仍然生效：Windows 系统代理、启动环境变量（HTTP_PROXY / HTTPS_PROXY）。'
      else if (proxyConfigured) proxyShown = '已保存：' + proxyView.url + '（下一次工具调用立即使用）。'
      else proxyShown = '未配置：使用自动检测（Windows 系统代理 → 启动环境变量）。'
      var proxyBlock = React.createElement('div', { style: S.infoBox },
        React.createElement('div', { style: S.infoHead },
          React.createElement('p', { style: S.infoLabel }, '本地代理（可选）'),
          proxyConfigured && proxyView.phase === 'ready'
            ? React.createElement('button', { type: 'button', style: S.smallButton, onClick: onProxyClear, disabled: !proxyView.writable }, '清除')
            : null),
        React.createElement('p', { style: S.note }, '代理软件只监听本地端口、没有开启系统代理时，自动检测找不到它——把它的地址填在这里即可（例如 http://127.0.0.1:7897）。支持 http:// 与 https://（可省略协议头）。'),
        React.createElement('div', { style: S.row },
          React.createElement('input', {
            style: S.input,
            type: 'text',
            value: proxyInput,
            placeholder: 'http://127.0.0.1:7897',
            onChange: onProxyInput,
            autoComplete: 'off',
            spellCheck: false,
            disabled: proxyView.phase !== 'ready' || !proxyView.writable,
          }),
          React.createElement('button', {
            style: S.button,
            onClick: onProxySave,
            disabled: proxyView.phase !== 'ready' || !proxyView.writable,
          }, '保存')),
        proxyStatus !== '' ? React.createElement('p', { style: proxyStatusStyle }, proxyStatus) : null,
        React.createElement('p', { style: S.note }, proxyShown),
        proxyView.phase === 'ready' && !proxyView.writable
          ? React.createElement('p', { style: S.note }, '当前环境只读（设置文档不可写），无法在此修改；可用环境变量 JINA_PROXY_URL 代替。')
          : null)

      // ---- reader options block ---------------------------------------------
      // The reader policy of the same namespace: the image policy, the alt-text
      // switch, and the selector group. All of it is written through the same
      // revision-fenced `writeProxy`, so a save here cannot clobber a proxy
      // edit made in the other block.
      var optsReady = proxyView.phase === 'ready' && proxyView.writable
      var optsStatusStyle = optsStatusKind === 'ok' ? S.statusOk : (optsStatusKind === 'bad' ? S.statusBad : S.status)
      var optsReport = function (kind, message) { setOptsStatusKind(kind); setOptsStatus(message) }

      function onOptsCheck(setter) {
        return function (e) {
          optsDirty.current = true
          setter(e.target.checked)
        }
      }

      function onOptsText(setter) {
        return function (e) {
          optsDirty.current = true
          setter(e.target.value)
        }
      }

      function onOptsSave() {
        // Only deviations are stored: `unset` is how a field returns to the
        // host default (see proxy.js `toolSettingsOf`).
        var ops = [
          { op: imagePolicyInput === 'all' ? 'unset' : 'set', path: [IMAGE_POLICY_FIELD], value: imagePolicyInput },
          { op: autoAltInput ? 'set' : 'unset', path: [AUTO_ALT_FIELD], value: true },
          { op: selectorsInput ? 'unset' : 'set', path: [SELECTORS_FIELD], value: false },
        ]
        var target = targetSelectorInput.trim()
        var remove = removeSelectorInput.trim()
        ops.push(target === ''
          ? { op: 'unset', path: [TARGET_SELECTOR_FIELD] }
          : { op: 'set', path: [TARGET_SELECTOR_FIELD], value: target })
        ops.push(remove === ''
          ? { op: 'unset', path: [REMOVE_SELECTOR_FIELD] }
          : { op: 'set', path: [REMOVE_SELECTOR_FIELD], value: remove })
        optsDirty.current = false
        writeProxy(ops, '工具选项已保存，下一次调用立即生效。', optsReport)
      }

      var optionsBlock = React.createElement('div', { style: S.infoBox },
        React.createElement('p', { style: S.infoLabel }, '阅读工具选项'),
        React.createElement('label', { style: S.checkRow },
          React.createElement('input', {
            type: 'checkbox',
            checked: autoAltInput,
            onChange: onOptsCheck(setAutoAltInput),
            disabled: !optsReady,
          }),
          React.createElement('span', { style: S.checkLabel }, '自动为缺少说明的图片生成 alt 文本（需要 API key，会计入 token 消耗）')),
        React.createElement('label', { style: S.checkRow },
          React.createElement('input', {
            type: 'checkbox',
            checked: selectorsInput,
            onChange: onOptsCheck(setSelectorsInput),
            disabled: !optsReady,
          }),
          React.createElement('span', { style: S.checkLabel }, '自动去除页眉/页脚/广告等噪声并优先取正文容器（命中不到时自动回退整页，不会返回空）')),
        React.createElement('div', { style: S.row },
          React.createElement('span', { style: S.checkLabel }, '图片保留策略'),
          React.createElement('select', {
            style: S.select,
            value: imagePolicyInput,
            onChange: onOptsText(setImagePolicyInput),
            disabled: !optsReady,
          },
            React.createElement('option', { value: 'all' }, 'all —— 保留全部图片（Jina 默认）'),
            React.createElement('option', { value: 'alt' }, 'alt —— 只保留 alt 文本（省 token）'),
            React.createElement('option', { value: 'none' }, 'none —— 不保留图片'))),
        React.createElement('input', {
          style: S.input,
          type: 'text',
          value: targetSelectorInput,
          placeholder: '正文选择器（留空使用内置列表）',
          onChange: onOptsText(setTargetSelectorInput),
          autoComplete: 'off',
          spellCheck: false,
          disabled: !optsReady,
        }),
        React.createElement('input', {
          style: S.input,
          type: 'text',
          value: removeSelectorInput,
          placeholder: '排除选择器（留空使用内置列表）',
          onChange: onOptsText(setRemoveSelectorInput),
          autoComplete: 'off',
          spellCheck: false,
          disabled: !optsReady,
        }),
        React.createElement('div', { style: S.row },
          React.createElement('button', { type: 'button', style: S.button, onClick: onOptsSave, disabled: !optsReady }, '保存选项')),
        optsStatus !== '' ? React.createElement('p', { style: optsStatusStyle }, optsStatus) : null,
        React.createElement('p', { style: S.note }, '每次 jina_read 都会固定发送三个零副作用的 Reader 参数：X-Preset: agent（官方 agent 预设，只填充未显式设置的项）、X-Base: final（用跳转后的 URL 解析相对链接）、X-Timeout: 120（与客户端 120s 上限对齐，慢页面兜底）。'))

      // ---- key pool block ---------------------------------------------------
      // ONE input and an add control, and nothing else: no list, no per-key row,
      // no remove control. The host keeps the pool clean on its own (a key that
      // is exhausted or revoked is discarded), so there is nothing for the user
      // to manage here — paste a key, click 添加, done.
      var keyBlock = React.createElement('div', { style: S.infoBox },
        React.createElement('p', { style: S.infoLabel }, 'API key（可保存多个，额度耗尽自动丢弃）'),
        React.createElement('p', { style: S.note }, '粘贴一个 key 后点「添加」，可以一直往里加。插件自动轮换：某个 key 失效（401）或额度耗尽（402 / 余额为 0）时会被自动丢弃，其余 key 继续服务，任务不会中途断掉；限流（429）只是临时跳过。'),
        React.createElement('div', { style: S.row },
          React.createElement('input', {
            style: S.input,
            type: 'password',
            value: keyDraft,
            placeholder: '粘贴 API key…',
            onChange: onKeyInput,
            autoComplete: 'off',
            spellCheck: false,
            disabled: credentialsMissing || keysLoading || keyFull,
          }),
          React.createElement('button', {
            style: S.button,
            onClick: onAdd,
            disabled: credentialsMissing || keysLoading || keyFull,
          }, '添加')),
        keyStatus.message !== '' ? React.createElement('p', { style: keyStatusStyle }, keyStatus.message) : null,
        !credentialsMissing && !keysLoading && poolCount === 0
          ? React.createElement('p', { style: S.note }, '还没有 key（当前使用 Jina 匿名免费配额）。添加一个即可；建议再加一个备用 key。')
          : null,
        keyFull
          ? React.createElement('p', { style: S.note }, '已填满 ' + KEY_REFS.length + ' 个槽位；不可用的 key 会被自动丢弃，之后即可继续添加。')
          : null,
        credentialsMissing
          ? React.createElement('p', { style: S.statusBad }, '⚠️ 当前环境未挂载凭据控制面（credentials Remote），无法在此保存 key；可改用 jina-api-key.txt（每行一个 key）或同名环境变量。')
          : null,
        !credentialsMissing && keysLoading ? React.createElement('p', { style: S.note }, '正在读取已保存的 key…') : null,
        !credentialsMissing && !keysLoading && poolCount > 0 && keyCount === 0
          ? React.createElement('p', { style: S.note }, '轮换池里的 key 来自 jina-api-key.txt 文件（每行一个）；文件不会被自动改写，因此这些 key 失效时只是被跳过。')
          : null)

      // ---- key health block -------------------------------------------------
      var primerLines
      if (primer.phase === 'loading') {
        primerLines = [React.createElement('p', { key: 'p', style: S.status }, '正在连接 Jina 检测 key…')]
      } else if (primer.phase === 'error') {
        primerLines = [
          React.createElement('p', { key: 'e', style: S.statusBad }, '❌ 无法连接 Jina：' + String(primer.error)),
          React.createElement('p', { key: 'h', style: S.note }, '先确认本地代理正在运行，且「本地代理」里填写的地址/端口与它一致（没有填写时请确认 VPN / 系统代理已开启或环境变量已设置），然后点击右侧「刷新」重试。'),
        ]
      } else {
        var d = primer.data || {}
        // Everything the page says about keys: how many the pool holds and the
        // credits behind them. Nothing per key, and no usable/total fraction —
        // an unusable key is discarded by the host, so the count is the count.
        var total = typeof d.keyCount === 'number' ? d.keyCount : 0
        var totalBalance = typeof d.balanceTotal === 'number' ? d.balanceTotal.toLocaleString('en-US') + ' credits' : '未知'
        primerLines = [
          React.createElement('p', { key: 'ok', style: S.statusOk }, '✅ 连接正常，key 可用'),
          React.createElement('p', { key: 'total', style: S.mono }, 'Key 总数：' + total + ' 个'),
          React.createElement('p', { key: 'bal', style: S.mono }, '总余额：' + totalBalance),
        ]
        if (total === 0) {
          primerLines.push(React.createElement('p', { key: 'none', style: S.note }, '尚未保存 key：添加一个即可；当前使用 Jina 匿名免费配额。'))
        }
        if (typeof d.discardedCount === 'number' && d.discardedCount > 0) {
          primerLines.push(React.createElement('p', { key: 'discarded', style: S.note }, '本次检测自动丢弃了 ' + d.discardedCount + ' 个已失效或额度耗尽的 key。'))
        }
      }
      // The probe reports which proxy it actually used — the one fact that
      // tells a working manual address apart from a lucky environment variable.
      var probe = primer.data && primer.data.proxy ? primer.data.proxy : undefined
      var probeLines = []
      if (probe !== undefined) {
        var probeLabel = probe.url
          ? probe.url + '（来源：' + String(PROXY_SOURCES[probe.source] || probe.source || '未知') + '）'
          : '无（直连）'
        probeLines.push(React.createElement('p', { key: 'proxy', style: S.mono }, '本次检测所用代理：' + probeLabel))
      }
      if (probe !== undefined && Array.isArray(probe.rejected) && probe.rejected.length > 0) {
        var rejectReason = String(PROXY_REJECTS[probe.rejected[0].reason] || probe.rejected[0].reason)
        probeLines.push(React.createElement('p', { key: 'rejected', style: S.statusBad }, '⚠️ 已保存的代理「' + probe.rejected[0].value + '」不可用（' + rejectReason + '），已回退到自动检测。'))
      }
      var primerBlock = React.createElement('div', { style: S.infoBox },
        React.createElement('div', { style: S.infoHead },
          React.createElement('p', { style: S.infoLabel }, 'API key / 连接检测'),
          React.createElement('button', {
            type: 'button',
            style: S.smallButton,
            onClick: loadPrimer,
            disabled: primer.phase === 'loading',
          }, '刷新')),
        primerLines,
        probeLines)

      /**
       * The configuration form both surfaces render.
       *
       * Defined INSIDE the component on purpose: the form reads this
       * component's own state and handlers (`keyBlock`, `keyDraft`,
       * `keyStatus`, `onAdd`, `keyCount`, `keysLoading`, `proxyBlock`,
       * `optionsBlock`, `primerBlock`). Hoisting it to factory scope — as 0.7.0
       * did — leaves every one of those bindings unresolved: the slot entry
       * throws `ReferenceError: input is not defined`, the Plugins page swaps
       * the whole configuration section for an error boundary, and the API key
       * plus local-proxy fields silently disappear from the UI.
       * `test/client-render.test.js` renders both views to keep it here.
       * @returns the form column.
       */
      function body() {
        return React.createElement('div', { style: S.body },
            React.createElement('p', { style: S.note }, 'jina_web_search / jina_read 等工具会优先使用这里保存的 key，某个 key 失效或额度耗尽时自动丢弃并切换到下一个。免费 key 可在 ', React.createElement('a', { style: S.link, href: 'https://jina.ai/?sui=apikey', target: '_blank', rel: 'noreferrer' }, 'jina.ai'), ' 获取。'),
            keyBlock,
            proxyBlock,
            optionsBlock,
            primerBlock,
            !keysLoading && keyCount > 0
              ? React.createElement('p', { style: S.note }, '提示：key 明文只在本机保存（dsh 凭据存储，如 ~/.dsh/.credentials.yaml），本页不会读回已保存的值；失效或额度耗尽的 key 由插件自动丢弃，不需要手动管理。')
              : null,
            React.createElement('p', { style: S.note }, 'key 解析顺序：1. 工具参数 apiKey（单个，不轮换）；2. 本页添加的 key（保存在 dsh 凭据存储里，按添加顺序轮换）；3. 会话工作区的 jina-api-key.txt（每行一个 key）；4. dsh 主目录下的 jina-api-key.txt。添加后立即生效。'),
            React.createElement('p', { style: S.note }, '代理优先级：1. 本页「本地代理」保存的地址；2. 环境变量 JINA_PROXY_URL；3. Windows 系统代理（自动发现，端口变化会自愈）；4. 继承启动环境的 HTTP_PROXY / HTTPS_PROXY。只有 http(s) 代理可用于网络 helper。中国大陆网络环境下调用 Jina 需要代理；本地代理只监听端口、未开启系统代理时，请填上面的「本地代理」。'))
      }

      var title = 'Jina Tools'
      var description = 'Jina AI 搜索/阅读/嵌入等工具的多个 API key（自动轮换、失效自动丢弃）、本地代理与阅读选项。'

      // The Plugins page draws the card's title, icon, and crumb itself and
      // asks a configuration entry for one of two views: `summary` is the
      // one-liner under the title, `page` is the form with its own save
      // control.
      if (props.view === 'summary') return description
      if (props.view === 'page') return body()

      // Legacy Settings → Plugins → Configure card (`settings.plugin.item`):
      // that slot carries no page chrome, so the card owns a header toggle and
      // a collapsible body. Drop this arm and the legacy registration in
      // `apply` once no supported harness declares that slot.
      return React.createElement('li', { style: S.card },
        React.createElement('button', {
          type: 'button',
          style: S.header,
          'aria-expanded': open,
          onClick: function () { setOpen(!open) },
        },
          React.createElement('span', { style: S.headText },
            React.createElement('span', { style: S.name }, title),
            React.createElement('span', { style: S.description }, description)),
          React.createElement(Chevron, { open: open })),
        open ? body() : null)
    }

    exports.name = 'dsh-jina'
    // Every Remote namespace the gateway mounts is its own cordis service, so a
    // consumer that reads `remote.<ns>` must declare it here — the property
    // access itself throws `cannot get property "remote.settings" without
    // inject` otherwise (which crashes the settings slot entry and makes the
    // card vanish). `remote.credentials` and `remote.settings` are read
    // through properties below; `remote` itself carries `$on`.
    exports.inject = ['slots', 'remote', 'remote.credentials', 'remote.settings']

    exports.apply = function (ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      var remote = ctx.get('remote')
      if (remote === undefined) return
      var credentials = ctx.get('remote.credentials')
      // The Plugins page's bundle-configuration slot (sidebar → Plugins → the
      // dsh-jina bundle), keyed by the bundle's package name: the page draws
      // the card and the entry supplies the form. `slots.inject` waits for the
      // declarer package and unregisters automatically if the surface goes
      // away.
      ctx.slots.inject('plugins.bundle.config', function () {
        return slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-jina' },
          function (slotProps) {
            return React.createElement(JinaCard, {
              remote: remote,
              credentials: credentials,
              view: slotProps === undefined ? undefined : slotProps.view,
            })
          },
        )
      })

      // Legacy Settings → Plugins → Configure card, kept so the bundle still
      // configures on a harness whose Plugins page declares only this slot.
      // Keyed by the settings namespace this card edits — 'jina-tools' — which
      // the host half serves. Remove once no supported harness declares it.
      ctx.slots.inject('settings.plugin.item', function () {
        return slots.register(
          { name: 'settings.plugin.item', key: 'jina-tools' },
          function () {
            return React.createElement(JinaCard, { remote: remote, credentials: credentials })
          },
        )
      })
    }

    return exports
  },
})
