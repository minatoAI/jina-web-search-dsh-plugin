// dsh-jina — browser bundle (prebuilt; no build step required).
//
// Executing this script only REGISTERS its factory with the client module
// system (`window.__ModuleLoader__.load`). The registration id MUST equal the
// boot-graph row id — the exact package name `dsh-jina` (the host's
// client-modules scan keys rows by package name; the runtime normalizes a
// trailing `/client` only, never a subpath). A subpath id (e.g. the historical
// `dsh-jina/ui`) registers a key nobody asks for, and the module system
// reports `loaded without registering "dsh-jina"`. The factory materializes on
// first import and returns a cordis client plugin that contributes a "Jina
// Tools" card to the standard plugin configuration surface (Settings → Plugins
// → Configure, the `settings.plugin.item` KEYED slot declared by the web
// settings package — the same surface that hosts the Terminal / Agent loop /
// Web search cards). A keyed entry is keyed by the settings namespace the card
// edits, so the card registers under `key: 'jina-tools'` — the same namespace
// the host half (index.js) serves — and the tab renders the card only when
// both halves agree on that namespace.
//
// The card manages the `JINA_API_KEY` credential through the standard
// credentials Remote namespace: `remote.credentials` (the generated `$mount`
// installs it as its own `remote.credentials` cordis service — inject it, do
// not reach through the `remote` object) with describe/set/unset. Values cross
// the wire only on save, and the page shows configured state, never the
// stored value. It refreshes when the Host reports the reference changed
// (`credentials/reference-updated`, observed on the `remote` service itself).
// It also runs the key health check: a GET to the host-provided
// `/api/dsh-jina/primer` route (registered by the bundle's host half when a
// web server is composed), which answers with the key's Jina identity and
// credit balance — the same data `jina_primer` reports. The key itself never
// leaves the host.
window.__ModuleLoader__.load({
  id: 'dsh-jina',
  factory: function (require) {
    var React = require('react')
    var exports = {}
    var CRED = 'JINA_API_KEY'

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
      var [input, setInput] = React.useState('')
      var [status, setStatus] = React.useState('')
      var [statusKind, setStatusKind] = React.useState('info') // 'info' | 'ok' | 'bad'
      var [view, setView] = React.useState(undefined) // {configured, writable} | undefined while loading
      var [primer, setPrimer] = React.useState({ phase: 'loading', data: undefined, error: undefined })

      var refresh = function () {
        if (credentials === undefined) return
        credentials.describe([CRED]).then(function (response) {
          if (!response || response.ok !== true) return
          setView(response.value[CRED])
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

      React.useEffect(function () {
        refresh()
        loadPrimer()
        var dispose = remote.$on('credentials/reference-updated', function (ref) {
          if (ref === CRED) {
            refresh()
            loadPrimer()
          }
        })
        return dispose
      }, [remote])

      function onInput(e) { setInput(e.target.value) }

      function onSave() {
        if (input.trim() === '') {
          setStatusKind('bad')
          setStatus('请输入 API key。')
          return
        }
        if (credentials === undefined) {
          setStatusKind('bad')
          setStatus('当前环境未挂载凭据控制面（credentials Remote），无法保存。')
          return
        }
        setStatusKind('info')
        setStatus('保存中…')
        credentials.set(CRED, input.trim()).then(function (response) {
          if (response && response.ok === true) {
            setStatusKind('ok')
            setStatus('已保存。')
            setInput('')
            refresh()
            loadPrimer()
          } else {
            setStatusKind('bad')
            setStatus('保存失败：' + String((response && response.error && response.error.message) || '未知错误'))
          }
        }, function () {
          setStatusKind('bad')
          setStatus('保存失败，请重试。')
        })
      }

      function onClear() {
        if (credentials === undefined) {
          setStatusKind('bad')
          setStatus('当前环境未挂载凭据控制面（credentials Remote），无法清除。')
          return
        }
        setStatusKind('info')
        setStatus('清除中…')
        credentials.unset(CRED).then(function (response) {
          if (response && response.ok === true) {
            setStatusKind('ok')
            setStatus('已清除。')
            refresh()
            loadPrimer()
          } else {
            setStatusKind('bad')
            setStatus('清除失败：' + String((response && response.error && response.error.message) || '未知错误'))
          }
        }, function () {
          setStatusKind('bad')
          setStatus('清除失败，请重试。')
        })
      }

      var configured = view ? view.configured === true : false
      var writable = view ? view.writable === true : false
      var shown = view === undefined
        ? '正在读取设置…'
        : configured
          ? 'API key 已保存（来源：' + String(view.source || '本机存储') + '）。粘贴新 key 并保存即可覆盖。'
          : '尚未保存 API key。'
      var statusStyle = statusKind === 'ok' ? S.statusOk : (statusKind === 'bad' ? S.statusBad : S.status)

      // ---- key health block -------------------------------------------------
      var primerLines
      if (primer.phase === 'loading') {
        primerLines = [React.createElement('p', { key: 'p', style: S.status }, '正在连接 Jina 检测 key…')]
      } else if (primer.phase === 'error') {
        primerLines = [
          React.createElement('p', { key: 'e', style: S.statusBad }, '❌ 无法连接 Jina：' + String(primer.error)),
          React.createElement('p', { key: 'h', style: S.note }, '请确认 VPN / 系统代理已开启，然后点击右侧「刷新」重试。'),
        ]
      } else {
        var d = primer.data || {}
        var balance = typeof d.balanceLeft === 'number' ? d.balanceLeft.toLocaleString('en-US') + ' credits' : '未知'
        var kindLabel = d.keyFound === true
          ? (d.keyKind === 'credential' ? '本页保存的 key' : 'key 文件（jina-api-key.txt）')
          : '未检测到 key（Jina 匿名免费配额）'
        primerLines = [
          React.createElement('p', { key: 'ok', style: S.statusOk }, '✅ 连接正常，key 可用'),
          React.createElement('p', { key: 'id', style: S.mono }, '身份：' + (d.authenticatedAs || '未知')),
          React.createElement('p', { key: 'bal', style: S.mono }, '余额：' + balance),
          React.createElement('p', { key: 'src', style: S.note }, '当前生效来源：' + kindLabel),
        ]
      }
      var primerBlock = React.createElement('div', { style: S.infoBox },
        React.createElement('div', { style: S.infoHead },
          React.createElement('p', { style: S.infoLabel }, 'API key 检测'),
          React.createElement('button', {
            type: 'button',
            style: S.smallButton,
            onClick: loadPrimer,
            disabled: primer.phase === 'loading',
          }, '刷新')),
        primerLines)

      return React.createElement('li', { style: S.card },
        React.createElement('button', {
          type: 'button',
          style: S.header,
          'aria-expanded': open,
          onClick: function () { setOpen(!open) },
        },
          React.createElement('span', { style: S.headText },
            React.createElement('span', { style: S.name }, 'Jina Tools'),
            React.createElement('span', { style: S.description }, 'Jina AI 搜索/阅读/嵌入等工具的 API key。')),
          React.createElement(Chevron, { open: open })),
        open
          ? React.createElement('div', { style: S.body },
            React.createElement('p', { style: S.note }, 'jina_web_search / jina_read 等工具会优先使用这里保存的 key。免费 key 可在 ', React.createElement('a', { style: S.link, href: 'https://jina.ai/?sui=apikey', target: '_blank', rel: 'noreferrer' }, 'jina.ai'), ' 获取。'),
            React.createElement('div', { style: S.row },
              React.createElement('input', {
                style: S.input,
                type: 'password',
                value: input,
                placeholder: '粘贴 API key…',
                onChange: onInput,
                autoComplete: 'off',
                spellCheck: false,
                disabled: view !== undefined && !writable,
              }),
              React.createElement('button', {
                style: S.button,
                onClick: onSave,
                disabled: view !== undefined && !writable,
              }, '保存'),
              configured
                ? React.createElement('button', { style: S.ghostButton, onClick: onClear, disabled: !writable }, '清除')
                : null),
            status !== '' ? React.createElement('p', { style: statusStyle }, status) : null,
            React.createElement('p', { style: S.note }, shown),
            primerBlock,
            view !== undefined && !writable ? React.createElement('p', { style: S.note }, '当前环境只读：key 由环境变量等来源提供，无法在此修改。') : null,
            React.createElement('p', { style: S.note }, 'key 解析顺序：1. 工具参数 apiKey；2. 本页保存的 key（credential 引用 ' + CRED + '，由 dsh 凭据存储持久化）；3. 会话工作区的 jina-api-key.txt；4. dsh 主目录下的 jina-api-key.txt。保存后立即生效。中国大陆网络环境下调用 Jina 需要 VPN；插件会自动发现并跟随系统代理（含代理端口变化）。'))
          : null)
    }

    exports.name = 'dsh-jina'
    exports.inject = ['slots', 'remote', 'remote.credentials']

    exports.apply = function (ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      var remote = ctx.get('remote')
      if (remote === undefined) return
      var credentials = ctx.get('remote.credentials')
      // Standard plugin-configuration card slot (Settings → Plugins →
      // Configure). `slots.inject` waits for the declarer package and
      // unregisters automatically if the surface disappears. Keyed by the
      // settings namespace this card edits — 'jina-tools' — which the host
      // half serves; the tab dispatches one entry per served namespace.
      ctx.slots.inject('settings.plugin.item', function () {
        return slots.register(
          { name: 'settings.plugin.item', key: 'jina-tools' },
          function (slotProps) {
            return React.createElement(JinaCard, { remote: remote, credentials: credentials })
          },
        )
      })
    }

    return exports
  },
})
