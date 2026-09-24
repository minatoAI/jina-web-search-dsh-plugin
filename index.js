/**
 * dsh-jina — Jina AI tools for DeepSeek Harness.
 *
 * Host plugin: registers the twelve jina_* model tools mirroring jina-cli
 * (search — with dedicated jina_search_arxiv / jina_search_ssrn academic
 * shortcuts so the model can hit the right domain without remembering the
 * `type` parameter — / read / screenshot / datetime / expand / embed /
 * rerank / classify / pdf / primer). The API key lives in the host credential seam
 * under the reference `JINA_API_KEY` — the "Jina Tools" web settings page
 * writes it through `credentials.set`, and this plugin resolves it per
 * operation (the seam's contract: never cache across operations). The web
 * settings pairing: the `jina-tools` Loader entry (contributed by this bundle's
 * `cordis.patch.yml`) *is* the settings namespace, and this host half declares
 * its live fields through the module-level `Config` export built by proxy.js —
 * `proxyUrl` carries a manually configured local proxy address and the
 * remaining fields carry the reader policy (`imagePolicy`,
 * `autoAltText`, `useSelectors` and the selector overrides). The browser half
 * registers its configuration form for that namespace, so the Plugins page
 * (the `dsh-jina` bundle card) renders the form only when the two halves agree.
 *
 * The API key is resolved per call in this order:
 *   1. the tool's own `apiKey` parameter (one key, never rotated),
 *   2. the credential slots `JINA_API_KEY`, `JINA_API_KEY_2` …
 *      `JINA_API_KEY_10` (set from the web settings page, persisted by the host
 *      credential provider, e.g. `.credentials.yaml`) — every configured slot
 *      joins the pool, in slot order,
 *   3. `jina-api-key.txt` in the calling session's workspace (one key per line),
 *   4. `jina-api-key.txt` in the dsh home directory (`$DSH_HOME` or `~/.dsh`).
 *
 * A pool, not a key, is what an operation uses: the key that served the last
 * success leads, and a key that answers 401 / 402 (quota exhausted) / 429 is
 * parked for a cooldown and the next key is tried, so one overdrawn account no
 * longer interrupts a running task. A key that is definitively unusable is
 * discarded outright: 401, 402 and a probe reporting a balance of zero delete
 * that credential, so the pool cleans itself and the user never manages a list.
 * A switch made mid-call is reported in the result; a pool that is entirely
 * exhausted names every key it tried and the status each one answered.
 * `keys.js` owns the pure rotation policy.
 *
 * Network transport: the Jina endpoints are contacted through a small
 * `node -e` fetch helper spawned via the host `subprocess` service. The
 * spawn environment inherits the harness-resolved proxy policy (dsh 0.1.3+:
 * HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY from the startup environment),
 * and a proxy is layered on top in this order (proxy.js owns the policy):
 *   1. a manual address from the "Jina Tools" settings card (`jina-tools` →
 *      `proxyUrl`) — the fix for a local proxy client that listens on a
 *      loopback port WITHOUT being the system proxy, which no automatic
 *      discovery can see,
 *   2. the `JINA_PROXY_URL` environment variable (headless profiles),
 *   3. the Windows system proxy (WinINET registry), rediscovered
 *      automatically when a transport failure suggests the port changed.
 * The card's health check (`/api/dsh-jina/primer`) reports the proxy actually
 * in effect, and transport failures name it, so a misconfigured address is
 * visible instead of looking like a generic network outage.
 */

import { homedir } from 'node:os'
import {
  KEY_FILE, KEY_REFS, clearKeyState, describeKeyStatus, isKeyFailoverStatus,
  keyPoolSignature, keyRotationOrder, keySourceLabel, keyStateAfter, keyStatusOf,
  parseKeyList,
} from './keys.js'
import { buildPrimer, formatPrimer, parseIpInfo, parseJinaRoot } from './primer.js'
import {
  DEFAULT_REMOVE_SELECTORS, DEFAULT_TARGET_SELECTORS, PROXY_ENV_VAR,
  READER_BASE, READER_PRESET, READER_TIMEOUT_SECONDS, SELECTOR_RETRY_MIN_CHARS,
  createSettingsSchema, describeRejectReason, proxySettingOf, selectProxy,
  settingsAreLive, settingsSnapshot, toolSettingsOf,
} from './proxy.js'
import { WEB_SEARCH_TOOL } from './tool-contracts.js'

export const name = 'dsh-jina'

export const inject = ['fs', 'subprocess', 'tools']

/**
 * The `jina-tools` live-field declaration.
 *
 * The entry id *is* the settings namespace (`cordis.patch.yml` contributes
 * `- id: jina-tools / name: dsh-jina`), and this export is what the settings
 * provider serves to the browser half: the harness resolves it through
 * `'~standard'.validate`, hands the result to `apply` as the second argument,
 * and writes every saved field straight into the volatile references that
 * result holds. That is what makes a save live: the card is editable only while
 * a row for this namespace exists, and this plugin is the row's only source.
 *
 * proxy.js owns the field list, the defaults and the cross-copy volatile
 * protocol; keeping the schema there is also what preserves the zero-dependency
 * promise (an out-of-tree bundle at this location cannot resolve the harness's
 * schemastery package).
 */
export const Config = createSettingsSchema()

/**
 * The network helper: a self-contained CommonJS script run as
 * `node -e <script>` by the host `subprocess` service. It reads one JSON
 * request from stdin and writes one JSON result to stdout, so the transport
 * never depends on a bundled HTTP client. Exported because it is the exact
 * code a proxy misconfiguration has to be diagnosed against (see
 * test/plugin-proxy.test.js and README → 开发说明).
 */
export const HTTP_HELPER_SCRIPT = [
  "const fs = require('fs')",
  "let input = ''",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', function (c) { input += c })",
  "process.stdin.on('end', function () {",
  "  let req = {}",
  "  try { req = JSON.parse(input || '{}') } catch (e) {",
  "    process.stdout.write(JSON.stringify({ ok: false, status: 0, text: 'bad request json: ' + e.message }), function () { process.exit(0) })",
  "    return",
  "  }",
  "  setTimeout(function () { process.exit(1) }, ((req && req.timeoutMs) || 60000) + 20000).unref()",
  "  try {",
  "    const options = { method: req.method || 'POST', headers: req.headers || {}, redirect: 'follow', signal: AbortSignal.timeout(req.timeoutMs || 60000) }",
  "    if (req.body !== undefined && req.body !== null) options.body = req.body",
  "    fetch(req.url, options).then(async function (res) {",
  "      const text = await res.text()",
  "      process.stdout.write(JSON.stringify({ ok: res.status >= 200 && res.status < 300, status: res.status, text: text }), function () { process.exit(0) })",
  "    }).catch(function (err) {",
  "      let detail = (err && err.message) || String(err)",
  "      if (err && err.name === 'TimeoutError') detail = 'timeout after ' + ((req && req.timeoutMs) || 60000) + 'ms'",
  "      if (err && err.cause && err.cause.message) detail = detail + ' (' + err.cause.message + ')'",
  "      process.stdout.write(JSON.stringify({ ok: false, status: 0, text: detail }), function () { process.exit(0) })",
  "    })",
  "  } catch (err) {",
  "    process.stdout.write(JSON.stringify({ ok: false, status: 0, text: 'helper error: ' + ((err && err.message) || String(err)) }), function () { process.exit(0) })",
  "  }",
  "})",
].join('\n')

export function apply(ctx, config) {
  const READER = 'https://r.jina.ai/'
  const IPINFO = 'https://ipinfo.io/json'
  const SEARCH = 'https://svip.jina.ai/'
  const API = 'https://api.jina.ai'
  const MAX_OUT = 1500000

  let nodePath
  /**
   * The key-file fallback, cached 30s like the single-key version was: the
   * parsed keys of the first non-empty candidate file, or `[]`. `undefined`
   * means "not read yet". The 401 path clears it so a file edited mid-session
   * is picked up without waiting the cache out.
   */
  let filePoolCache = { keys: undefined, at: 0 }
  let keyDiag = ''
  /**
   * Rotation state for the pool currently resolved: a signature (so saving or
   * clearing a key resets it), one state per pool index, and the round-robin
   * cursor (`lastUsed`, -1 before any call). In-memory only — a restart starts
   * from the first slot.
   */
  let keyPoolState = { signature: 0, states: [], lastUsed: -1 }
  let proxyCache = { text: undefined, at: 0, done: false }
  /**
   * The resolved `jina-tools` config for this plugin instance (see the `Config`
   * export above). The harness keeps this object's identity stable and writes a
   * saved field into its volatile references in place, so reading through
   * `settingsSnapshot()` at the start of an operation always sees the current
   * values — the same "never cache across operations" contract the API key has.
   * `undefined` on a harness that passes no config, which is why the readers
   * below fall back to the proxy.js defaults.
   */
  const settingsConfig = config
  let currentCwd = undefined

  /** dsh home directory: $DSH_HOME, else ~/.dsh. */
  function dshHome() {
    if (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) return process.env.DSH_HOME
    return homedir() + '/.dsh'
  }

  function workspaceRoot() {
    const sp = ctx.get('sandboxPolicy')
    if (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot.length > 0) return sp.workspaceRoot
    return homedir()
  }

  /** The calling agent's per-session workspace (canonical: exec.agent.session.header.cwd). */
  function sessionCwdOf(exec) {
    try {
      const c = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
      if (typeof c === 'string' && c.length > 0) return c
    } catch (e) { /* guarded */ }
    return undefined
  }

  function resolveRoot() {
    if (currentCwd) return currentCwd
    return workspaceRoot()
  }

  async function resolveNode() {
    if (nodePath === undefined) {
      try { nodePath = await ctx.subprocess.resolveExecutable('node') } catch (err) { nodePath = null }
    }
    return nodePath
  }

  function runCollect(argv, stdinData, maxBytes, env, signal) {
    return new Promise((resolve) => {
      const out = { exitCode: -1, stdout: { text: '' }, stderr: { text: '' } }
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv,
          cwd: resolveRoot(),
          stdio: {
            stdin: stdinData === undefined ? 'ignore' : { data: stdinData },
            stdout: { maxBytes: maxBytes || 65536, spill: { maxBytes: (maxBytes || 65536) * 4 } },
            stderr: { maxBytes: 65536, spill: { maxBytes: 262144 } },
          },
          graceMs: 2000,
          ...(signal !== undefined ? { signal } : {}),
          ...(env !== undefined ? { env } : {}),
        })
      } catch (err) {
        out.stderr.text = 'spawn failed: ' + String((err && err.message) || err)
        resolve(out)
        return
      }
      const finish = (err, outcome) => {
        try {
          if (err) out.stderr.text = String((err && err.message) || err)
          else {
            const so = handle.collected.stdout.readFrom(0)
            const se = handle.collected.stderr.readFrom(0)
            // The handle contract exposes exit facts through `done`
            // (SubprocessOutcome), not as a property on the handle itself.
            out.exitCode = outcome ? outcome.exitCode : undefined
            out.stdout = { text: so.text, lossy: so.lossy, spillPath: so.spillPath }
            out.stderr = { text: se.text }
          }
        } catch (e) { /* keep defaults */ }
        resolve(out)
      }
      handle.done.then((outcome) => finish(null, outcome), (err) => finish(err))
    })
  }

  /**
   * Resolve the rotation pool for one operation.
   *
   * Per-operation by contract: the credential seam documents that consumers
   * re-resolve at each operation so a changed credential reaches the next
   * operation without a restart. Every configured slot is resolved (one value
   * each — the seam stores one value per reference and never reads one back),
   * and the first source that yields at least one key wins, exactly as the
   * single-key lookup of 0.8.x did; the only change is that a source may now
   * contribute several keys and that the file may hold one key per line.
   *
   * @returns the pool, as `{ value, source, ref?, line? }` entries in try order.
   */
  async function loadKeyPool() {
    const keys = []
    const seen = new Set()
    const configured = []
    let unset = 0
    const notes = []
    const push = (raw, entry) => {
      const value = String(raw).trim()
      if (value === '' || seen.has(value)) return
      seen.add(value)
      keys.push({ ...entry, value })
    }
    try {
      const svc = ctx.get('credentials')
      if (svc === undefined) {
        notes.push('credential service absent')
      } else {
        for (const ref of KEY_REFS) {
          try {
            const resolved = await svc.resolve(ref)
            if (resolved && resolved.value) {
              // A slot may itself hold several keys (one per line) — a
              // hand-edited `.credentials.yaml` block scalar, or a key pasted
              // as a list. A real key never contains a newline, so splitting is
              // free and the whole pool keeps one parsing rule.
              const lines = parseKeyList(resolved.value)
              for (const value of lines) push(value, { source: 'credential', ref })
              configured.push(ref + '=' + String(resolved.source) + (lines.length > 1 ? '×' + lines.length : ''))
            } else {
              unset++
            }
          } catch (err) {
            configured.push(ref + '=' + String((err && err.message) || err))
          }
        }
      }
    } catch (err) {
      notes.push('credential lookup: ' + String((err && err.message) || err))
    }
    if (keys.length === 0) {
      // File sources: cached 30s; the 401 path invalidates and re-reads.
      if (filePoolCache.keys === undefined || Date.now() - filePoolCache.at >= 30000) {
        const root = resolveRoot()
        const home = dshHome()
        const candidates = [
          { source: 'workspace-file', path: root + '\\' + KEY_FILE, opts: undefined },
          { source: 'workspace-file', path: KEY_FILE, opts: { cwd: root } },
          { source: 'workspace-file', path: KEY_FILE, opts: undefined },
          { source: 'home-file', path: home + '\\' + KEY_FILE, opts: undefined },
          { source: 'home-file', path: KEY_FILE, opts: { cwd: home } },
        ]
        let found
        for (const c of candidates) {
          try {
            const target = await ctx.fs.resolve(c.path, c.opts)
            const lines = parseKeyList(await ctx.fs.readText(target))
            if (lines.length > 0) { found = { ...c, lines }; break }
            notes.push(c.source + ': empty file')
          } catch (err) {
            notes.push(c.source + ': ' + String((err && err.message) || err))
          }
        }
        filePoolCache = {
          keys: found === undefined
            ? []
            : found.lines.map((value, i) => ({ value, source: found.source, line: i + 1 })),
          at: Date.now(),
        }
        if (found !== undefined) notes.push(found.source + ': ' + found.lines.length + ' key(s)')
      } else {
        notes.push('file cache: hit (' + filePoolCache.keys.length + ' key(s))')
      }
      for (const entry of filePoolCache.keys) push(entry.value, entry)
    }
    // Compact on purpose: the diagnosis rides inside a user-facing error, and
    // listing every one of the ten unset slots would drown the useful part.
    keyDiag = 'credential slots: ' + (configured.length > 0
      ? configured.join(', ') + ' (' + unset + ' unset)'
      : 'none of ' + KEY_REFS.length + ' set')
      + (notes.length > 0 ? ' | key file: ' + notes.join('; ') : '')
    return keys
  }

  /** The first key of the pool — what a caller that only needs "a key exists" uses. */
  async function loadKey() {
    const keys = await loadKeyPool()
    return keys.length > 0 ? keys[0].value : undefined
  }

  /**
   * The rotation state for one resolved pool.
   *
   * A changed pool (a key added, discarded, replaced or cleared) resets the
   * cursor to the first slot and the cooldowns: the signature is what proves
   * the pool is the same one the states describe, a stale index would park the
   * wrong key, and re-verifying from the front is the honest reading of "the
   * pool changed, look again".
   * @param pool - the resolved pool.
   * @returns the live state object for that pool.
   */
  function keyStateFor(pool) {
    const signature = keyPoolSignature(pool)
    if (keyPoolState.signature !== signature || keyPoolState.states.length !== pool.length) {
      keyPoolState = { signature, states: pool.map(() => clearKeyState()), lastUsed: -1 }
    }
    return keyPoolState
  }

  /**
   * Discard one key that cannot serve a call any more.
   *
   * This is the whole "management" story of the pool: 401, 402 and a zero
   * balance delete the credential, so the user only ever adds keys. Only a
   * credential-sourced slot can be deleted — a key that came from a
   * `jina-api-key.txt` file is left alone (the plugin will not rewrite a user's
   * file) and a reference the launching environment supplies read-only is
   * refused by the seam; both fall back to the cooldown machinery.
   *
   * @param entry - the pool entry to discard.
   * @returns whether the credential was actually removed.
   */
  async function discardKey(entry) {
    if (entry === null || typeof entry !== 'object' || entry.source !== 'credential' || typeof entry.ref !== 'string') return false
    try {
      const svc = ctx.get('credentials')
      if (svc === undefined || typeof svc.unset !== 'function') return false
      await svc.unset(entry.ref)
      return true
    } catch (err) {
      return false
    }
  }

  /** The user-facing account of one failed key, for an error or a switch note. */
  function keyAttemptLabel(attempt) {
    const index = typeof attempt.index === 'number' ? attempt.index + 1 : '?'
    return '#' + index + '（' + keySourceLabel(attempt.entry) + '）' + describeKeyStatus(keyStatusOf(attempt.status), attempt.status)
      + (attempt.discarded === true ? '，已自动移除' : '')
  }

  /** The one-line note a successful call carries after a mid-call key switch. */
  function keySwitchNote(res) {
    if (res === null || typeof res !== 'object' || res.keySwitch === undefined || res.keySwitch === null) return ''
    const message = res.keySwitch.message
    return typeof message === 'string' && message !== '' ? '\n\n[' + message + ']' : ''
  }

  /**
   * Append the key-switch note to a formatted tool result. Raw JSON output
   * (`json: true`) is never touched — a note appended to JSON would no longer
   * parse, and the switch is a fact about the run, not part of the payload.
   * @param text - the formatted result.
   * @param res - the response the result came from.
   * @param asJson - whether the caller asked for the raw payload.
   * @returns the result, with the note when one applies.
   */
  function withKeyNote(text, res, asJson) {
    return asJson === true ? text : text + keySwitchNote(res)
  }

  /** System proxy (the local VPN): read the user-level WinINET registry settings. */
  async function discoverProxy() {
    if (proxyCache.done && Date.now() - proxyCache.at < 60000) return proxyCache.text
    let proxy
    try {
      const r = await runCollect(['reg.exe', 'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], undefined, 32768)
      const t = r.stdout.text || ''
      if (/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(t)) {
        const m = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(t)
        if (m) {
          const raw = m[1].trim()
          const hit = /(?:^|;)\s*https=([^;]+)/i.exec(raw)
          let addr = hit ? hit[1].trim() : raw
          if (!/^https?:\/\//i.test(addr)) addr = 'http://' + addr
          proxy = addr
        }
      }
    } catch (err) { proxy = undefined }
    proxyCache = { text: proxy, at: Date.now(), done: true }
    return proxy
  }

  /**
   * The manual proxy address stored by the settings card, re-read per operation
   * (same contract as the API key: a saved change reaches the next call without
   * a restart). '' while unconfigured.
   */
  function settingProxy() {
    try { return proxySettingOf(settingsSnapshot(settingsConfig)) } catch (err) { return '' }
  }

  /**
   * The reader policy stored by the settings card, re-read per operation (same
   * contract as the proxy address and the API key: a saved change reaches the
   * next call without a restart). proxy.js owns the normalization and the
   * defaults, so an unset (or entirely absent) config gets the defaults.
   */
  function toolSettings() {
    try { return toolSettingsOf(settingsSnapshot(settingsConfig)) } catch (err) { return toolSettingsOf(undefined) }
  }

  /**
   * Resolve the transport plan for one operation (proxy.js owns the
   * precedence: request > setting > JINA_PROXY_URL > WinINET > inherited env).
   * WinINET is only consulted when no explicit address exists, so a configured
   * local proxy never pays for a `reg.exe` probe.
   * @returns `{ url, source, envHint, rejected }`.
   */
  async function proxyPlan(request) {
    const env = process.env || {}
    const own = () => ({
      request: request === undefined || request === null || request === '' ? undefined : String(request),
      setting: settingProxy(),
      envVar: env[PROXY_ENV_VAR],
      env,
    })
    const explicit = selectProxy(own())
    if (explicit.url !== undefined) return explicit
    const system = await discoverProxy()
    return selectProxy({ ...own(), system })
  }

  /** Attach the plan actually used to a helper result, for diagnostics. */
  function withProxy(parsed, plan) {
    return {
      ...parsed,
      proxy: {
        url: plan.url === undefined ? null : plan.url,
        source: plan.source,
        rejected: plan.rejected.map((r) => ({ field: r.field, value: r.value, reason: r.reason })),
      },
    }
  }

  /** What the transport actually ran through. */
  function effectiveProxyHint(proxy) {
    if (proxy.source === 'setting') return '当前使用设置卡片（Jina Tools → 本地代理地址）里配置的代理 ' + proxy.url + '；请确认该本地代理正在运行、地址与端口正确（不需要时可在卡片中「清除」以回到自动检测）。'
    if (proxy.source === 'envVar') return '当前使用环境变量 ' + PROXY_ENV_VAR + '=' + proxy.url + '。'
    if (proxy.source === 'system') return '当前使用从 Windows 系统代理自动发现的 ' + proxy.url + '。'
    if (proxy.source === 'request') return '当前使用调用级指定的代理 ' + proxy.url + '。'
    if (proxy.source === 'environment') return '当前继承启动环境里的代理设置（HTTP_PROXY/HTTPS_PROXY）。'
    return '未检测到可用代理：Windows 系统代理未开启、启动环境没有 HTTP_PROXY/HTTPS_PROXY、设置卡片也没有填写本地代理地址。若你使用只监听本地端口的代理软件（如 Clash/v2ray），请在设置卡片的「本地代理地址」里填写它的地址（例如 http://127.0.0.1:7897）。'
  }

  /** Plain-language account of the proxy a request ran through. */
  function proxyHint(proxy) {
    if (!proxy) return ''
    const rejected = Array.isArray(proxy.rejected) ? proxy.rejected[0] : undefined
    if (rejected === undefined) return effectiveProxyHint(proxy)
    const where = rejected.field === 'envVar'
      ? '环境变量 ' + PROXY_ENV_VAR + ' 配置的代理'
      : rejected.field === 'request' ? '调用级指定的代理' : '设置卡片里配置的代理'
    return where + '「' + rejected.value + '」不可用（' + describeRejectReason(rejected.reason) + '），已回退到自动检测。' + effectiveProxyHint(proxy)
  }

  /** One HTTP call through the node helper. */
  async function jinaRequest(spec) {
    const node = await resolveNode()
    if (!node) return { ok: false, status: 0, text: 'node executable not found on PATH; the helper needs Node.js to make the HTTP call' }
    const plan = await proxyPlan(spec.proxy)
    const payload = JSON.stringify({
      url: spec.url,
      method: spec.method || 'POST',
      headers: spec.headers || {},
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
      timeoutMs: spec.timeoutMs || 60000,
    })
    const makeEnv = (p) => {
      // dsh 0.1.3+: the subprocess seam merges `env` over a scrubbed parent
      // base that already carries the harness-resolved proxy policy
      // (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY from the startup
      // environment + NODE_USE_ENV_PROXY). Returning `undefined` inherits
      // that base untouched; only a selected/overridden proxy layers on
      // top — and it never clobbers NO_PROXY (the base merges the user's
      // list with the loopback bypass). WinINET discovery stays as the
      // Windows complement to the env-only policy the harness resolves.
      if (p === undefined || p === null || p === '') return undefined
      let proxy = String(p)
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)) proxy = 'http://' + proxy
      const env = { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy }
      // Mirror the harness: Node parses proxy vars at startup under this
      // flag and exits on non-http(s) schemes, so a SOCKS value rides along
      // for non-Node consumers without the flag.
      if (/^https?:\/\//i.test(proxy)) env.NODE_USE_ENV_PROXY = '1'
      return env
    }
    const parse = (r) => {
      // The helper's stdout is capped at MAX_OUT. A body past the cap comes back
      // flagged `lossy`, and JSON.parse on that truncated slice would report a
      // baffling "not parseable" next to a mid-payload snippet. Name the real
      // problem instead, and point at the spilled full body when there is one.
      if (r.stdout.lossy === true) {
        return {
          ok: false,
          status: 0,
          text: 'the Jina response exceeded the transport cap (' + MAX_OUT + ' bytes) and was truncated'
            + (typeof r.stdout.spillPath === 'string' && r.stdout.spillPath !== '' ? '; the full body was spilled to ' + r.stdout.spillPath : '')
            + '. Narrow the request (fewer pages, a target selector, a smaller maxEdge) and retry.',
        }
      }
      let parsed
      try { parsed = JSON.parse(r.stdout.text) } catch (e) {
        return { ok: false, status: 0, text: 'helper output not parseable: ' + String(r.stdout.text).slice(0, 300) + (r.stderr.text ? ' [stderr: ' + String(r.stderr.text).slice(0, 300) + ']' : '') }
      }
      if (typeof parsed !== 'object' || parsed === null) return { ok: false, status: 0, text: 'bad helper output: ' + String(r.stdout.text).slice(0, 300) }
      return parsed
    }
    let r = await runCollect([node, '-e', HTTP_HELPER_SCRIPT], payload, MAX_OUT, makeEnv(plan.url), spec.signal)
    let parsed = withProxy(parse(r), plan)
    if (parsed.ok || parsed.status !== 0) return parsed
    // Transport-level failure: retry once. An automatically discovered proxy is
    // rediscovered first (the VPN may have restarted on a new port); a manually
    // configured address is honored as-is — it is the user's explicit choice and
    // second-guessing it would hide the very misconfiguration they must fix.
    const explicit = plan.source === 'setting' || plan.source === 'envVar' || plan.source === 'request'
    let retryPlan = plan
    if (!explicit) {
      proxyCache = { text: undefined, at: 0, done: false }
      retryPlan = await proxyPlan(spec.proxy)
    }
    r = await runCollect([node, '-e', HTTP_HELPER_SCRIPT], payload, MAX_OUT, makeEnv(retryPlan.url), spec.signal)
    return withProxy(parse(r), retryPlan)
  }

  /**
   * Walk one pool until a key serves the call.
   *
   * A failover status (401/402/429) parks that key for its cooldown and moves
   * on; any other failure stops the walk, because rotating cannot help and
   * would spend the rest of the pool on a non-key problem. `tried` dedupes by
   * value, so a key that appears twice in one operation is never requested
   * twice.
   *
   * @param pool - the resolved pool.
   * @param state - the rotation state for that pool.
   * @param attempts - collector for the failed attempts, for the diagnosis.
   * @param tried - the key values already requested in this operation.
   * @param mkRequest - builds one request for a key (the caller's own headers).
   * @returns `{ res, index, fatal }` — the response that settled the walk, and
   *   whether it was a non-failover failure (the walk must not continue).
   */
  async function walkKeyPool(pool, state, attempts, tried, mkRequest) {
    let last
    for (const index of keyRotationOrder(pool.length, state.lastUsed, state.states, Date.now())) {
      const entry = pool[index]
      if (tried.has(entry.value)) continue
      tried.add(entry.value)
      const res = await jinaRequest(mkRequest(entry.value))
      if (res.ok) {
        state.lastUsed = index
        state.states[index] = clearKeyState()
        return { res, index, fatal: false }
      }
      if (!isKeyFailoverStatus(res.status)) return { res, index, fatal: true }
      // A revoked or overdrawn key is discarded, not parked: the user only ever
      // adds keys, the plugin keeps the pool clean. 429 stays (temporary).
      const discarded = res.status === 401 || res.status === 402 ? await discardKey(entry) : false
      attempts.push({ index, status: res.status, entry, discarded })
      state.states[index] = keyStateAfter(state.states[index], res.status, Date.now())
      last = res
    }
    return { res: last, index: -1, fatal: false }
  }

  /**
   * Full call: key pool + auth header + automatic failover.
   *
   * An explicit `apiKey` parameter is the caller's own choice: it is used
   * alone, with no rotation (there is nothing to rotate to). Otherwise the
   * resolved pool is walked, the last successful key leads the next call, and
   * a switch made mid-call is reported on the result as `keySwitch` so the
   * tools can tell the user that a key was overdrawn.
   */
  async function callJina(opts) {
    const headers = {}
    for (const k of Object.keys(opts.headers || {})) headers[k] = opts.headers[k]
    const explicit = opts.apiKey !== undefined && opts.apiKey !== null && opts.apiKey !== ''
    const mk = () => ({ url: opts.url, method: opts.method || 'POST', headers, body: opts.body, timeoutMs: opts.timeoutMs, signal: opts.signal, ...(opts.proxy !== undefined ? { proxy: opts.proxy } : {}) })
    if (explicit) {
      headers.Authorization = 'Bearer ' + String(opts.apiKey)
      return jinaRequest(mk())
    }
    const pool = await loadKeyPool()
    if (pool.length === 0) {
      if (opts.needsKey) {
        return { ok: false, status: 401, text: 'Jina API key required for this command. Save one or more keys in the DSH settings page (Plugins → dsh-jina → API key), or put one key per line in ' + KEY_FILE + ' in the session workspace or the dsh home directory. Get a free key at https://jina.ai/?sui=apikey' + (keyDiag ? ' [key lookup: ' + keyDiag + ']' : '') }
      }
      return jinaRequest(mk())
    }
    // The walk reuses the caller's headers and one request shape; only the
    // Authorization header changes between keys.
    const mkKeyRequest = (key) => ({ ...mk(), headers: { ...headers, Authorization: 'Bearer ' + key } })
    const state = keyStateFor(pool)
    const attempts = []
    const tried = new Set()
    let outcome = await walkKeyPool(pool, state, attempts, tried, mkKeyRequest)
    if (outcome.res !== undefined && outcome.res.ok) {
      if (attempts.length > 0) outcome.res.keySwitch = keySwitchOf(pool, attempts, outcome.index)
      return outcome.res
    }
    if (outcome.fatal) return attempts.length > 0 ? { ...outcome.res, keyAttempts: attempts } : outcome.res
    // Every key answered a failover status. Re-read the sources once before
    // giving up: the fix (a corrected credential or key file) may have landed
    // while this call was running, which is the case the old 401 re-read served.
    filePoolCache = { keys: undefined, at: 0 }
    const refreshed = await loadKeyPool()
    if (refreshed.length > 0 && refreshed.some((entry) => !tried.has(entry.value))) {
      const freshState = keyStateFor(refreshed)
      outcome = await walkKeyPool(refreshed, freshState, attempts, tried, mkKeyRequest)
      if (outcome.res !== undefined && outcome.res.ok) {
        if (attempts.length > 0) outcome.res.keySwitch = keySwitchOf(refreshed, attempts, outcome.index)
        return outcome.res
      }
    }
    return outcome.res === undefined ? { ok: false, status: 0, text: 'no API key could be tried' } : { ...outcome.res, keyAttempts: attempts }
  }

  /** The note describing a switch: which keys failed, and which one took over. */
  function keySwitchOf(pool, attempts, index) {
    const failed = attempts.map(keyAttemptLabel).join('；')
    return {
      index,
      message: '已自动切换 API key：' + failed + '，改用 #' + (index + 1) + '（' + keySourceLabel(pool[index]) + '）。可在 Plugins → dsh-jina 卡片里添加新的 key。',
    }
  }

  function describeJinaError(res) {
    const status = res.status || 0
    const body = String(res.text || '').slice(0, 800)
    // 422 is not one thing, so it is routed by the message the Reader sends:
    //   - "with target selector …"  → the CSS selector matched nothing;
    //   - "No content available"    → the page yielded nothing at all;
    //   - "Screenshot of the page is not available" → the page could not be
    //     RENDERED. That last one is the render step the OCR pipeline depends
    //     on, and the same failure comes back as HTTP 200 with fabricated text
    //     on other pages, so it must never be reported as "your arguments are
    //     invalid" — the model would then "fix" perfectly good parameters.
    let hint422 = 'Invalid request parameters.'
    if (/screenshot of the page is not available/i.test(body)) {
      hint422 = 'The Reader could not render this page (screenshot unavailable). Retrying later sometimes works; for a text page prefer the plain extractor over OCR.'
    } else if (/with target selector/i.test(body)) {
      hint422 = 'The target selector matched nothing on this page. Retry with targetSelector: "" to read the whole page.'
    } else if (/no content available/i.test(body)) {
      hint422 = 'The Reader extracted no content from this URL. If a target selector was sent, it may simply match nothing on this page (retry with targetSelector: "").'
    }
    const hints = {
      0: 'No response from the Jina API (network/VPN problem). Check that the local VPN and its system proxy are enabled, then retry.',
      401: 'Invalid or expired API key. Fix: update it in the DSH settings page (Jina Tools) or the key file. Get a free key: https://jina.ai/?sui=apikey',
      402: 'API quota exhausted. Fix: top up credits at https://jina.ai/api-dashboard/billing',
      422: hint422,
      429: 'Rate limit hit. Wait a few seconds and retry, or add an API key for higher limits.',
    }
    let msg = 'Jina API error (HTTP ' + status + '). ' + (hints[status] || '')
    // A transport failure is where a wrong proxy address shows up: name the
    // proxy that was actually in play instead of a generic network outage.
    if (status === 0) {
      const hint = proxyHint(res.proxy)
      if (hint !== '') msg += ' ' + hint
    }
    if (status >= 500) {
      msg = 'Jina API server error (HTTP ' + status + '). Retry in a moment; status: https://status.jina.ai'
      // Official guidance for the model pipelines: they are serverless, a cold
      // start answers 503, and the vendor says to retry after 30-60 seconds.
      if (status === 503) msg += ' If this call used jina-ocr-v1 (jina_read_pdf), a cold start is the likely cause — the vendor\'s guidance is to retry after 30–60 seconds.'
    }
    // The pool's own account of what it tried: a quota error on a single key
    // reads very differently once the user can see every saved key was tried.
    if (Array.isArray(res.keyAttempts) && res.keyAttempts.length > 0) {
      const tried = res.keyAttempts.map(keyAttemptLabel).join('；')
      msg += '\nAPI key 轮换：已依次尝试 ' + res.keyAttempts.length + ' 个 key —— ' + tried + '。'
        + (res.keyAttempts.length > 1 ? '所有已保存的 key 都已尝试。' : '')
        + '修复：在 Plugins → dsh-jina 卡片里添加可用的 key（https://jina.ai/?sui=apikey），或为已耗尽的账号充值（https://jina.ai/api-dashboard/billing）。'
    }
    if (body) msg += '\nServer said: ' + body
    return msg
  }

  /**
   * Statuses where the model must change its call or its credential: these
   * throw so the harness marks the result `isError: true` — the only shape
   * that reliably stops the model from treating the payload as data.
   * Environmental / transient statuses (0 network, 402 quota, 429 rate limit,
   * 5xx) stay returned: their hint tells the model to relay the problem to the
   * user or retry, not to "fix" its own arguments.
   */
  const FATAL_JINA_STATUSES = new Set([401, 422])

  /** Turn a failed response into an error (fatal status) or a returned hint. */
  function failJina(res) {
    const message = describeJinaError(res)
    if (FATAL_JINA_STATUSES.has(res.status || 0)) throw new Error(message)
    return message
  }

  /** Per-call session workspace + signal; run at the top of every execute. */
  const enterExec = (exec) => {
    const cwd = sessionCwdOf(exec)
    if (cwd !== undefined) currentCwd = cwd
    return (exec && exec.signal) || undefined
  }

  function fmtSearch(text, asJson) {
    if (asJson) return text
    let data
    try { data = JSON.parse(text) } catch (e) { return text }
    const results = data && Array.isArray(data.results) ? data.results : undefined
    if (results === undefined) return text
    if (results.length === 0) return '(no results)'
    const lines = []
    for (const r of results) {
      if (r && typeof r === 'object') {
        lines.push(String(r.title || '(untitled)'))
        if (r.url) lines.push('  ' + String(r.url))
        if (r.snippet) lines.push('  ' + String(r.snippet))
      } else {
        lines.push(String(r))
      }
      lines.push('')
    }
    return lines.join('\n').trim()
  }

  function fmtDatetime(text, asJson) {
    if (asJson) return text
    try {
      const data = JSON.parse(text)
      const d = data && typeof data === 'object' ? (data.data || data) : data
      if (d && typeof d === 'object') {
        const lines = []
        if (typeof d.title === 'string' && d.title.length > 0) lines.push('title: ' + d.title)
        if (typeof d.description === 'string' && d.description.length > 0 && d.description !== d.title) lines.push('description: ' + String(d.description).slice(0, 200))
        const times = []
        const mk = d.metadata && typeof d.metadata === 'object' ? d.metadata : {}
        for (const k of ['publishedTime', 'article:published_time', 'bytedance:published_time', 'article:modified_time', 'bytedance:updated_time']) {
          const v = typeof mk[k] === 'string' ? mk[k] : (typeof d[k] === 'string' ? d[k] : undefined)
          if (v !== undefined && v.length > 0) times.push(k + ': ' + v)
        }
        if (times.length > 0) lines.push(times.join(' | '))
        if (typeof d.url === 'string' && d.url.length > 0) lines.push('url: ' + d.url)
        if (lines.length > 0) return lines.join('\n')
      }
    } catch (e) { /* fall through */ }
    return text
  }

  function fmtScreenshot(text) {
    try {
      const data = JSON.parse(text)
      const d = data && typeof data === 'object' ? (data.data || data) : data
      if (d && typeof d === 'object') {
        const u = d.screenshotUrl || d.pageshotUrl || d.url
        if (typeof u === 'string' && u.length > 0) return 'screenshot URL: ' + u
        const b64 = d.screenshot || d.image
        if (typeof b64 === 'string' && b64.length > 0) return 'screenshot returned as embedded base64 image data (' + b64.length + ' chars)'
      }
    } catch (e) { /* fall through */ }
    return text
  }

  function fmtExpand(text, asJson) {
    if (asJson) return text
    try {
      const data = JSON.parse(text)
      const list = Array.isArray(data) ? data : (data && (data.results || data.data))
      if (Array.isArray(list)) {
        const lines = []
        for (const r of list) {
          if (typeof r === 'string') lines.push(r)
          else if (r && typeof r === 'object') lines.push(String(r.query || r.text || ''))
        }
        const filtered = lines.filter((l) => l && l.length > 0)
        if (filtered.length > 0) return filtered.join('\n')
      }
    } catch (e) { /* fall through */ }
    return text
  }

  function fmtEmbed(text, asJson) {
    if (asJson) return text
    try {
      const data = JSON.parse(text)
      const items = Array.isArray(data) ? data : (data && data.data)
      if (Array.isArray(items)) {
        const lines = []
        items.forEach((item, i) => {
          const emb = item && Array.isArray(item.embedding) ? item.embedding : item
          if (Array.isArray(emb)) {
            const preview = emb.slice(0, 5).map((v) => Number(v).toFixed(6)).join(', ')
            lines.push('[' + (item && item.index !== undefined ? item.index : i) + '] dim=' + emb.length + ' [' + preview + ', ...]')
          }
        })
        if (lines.length > 0) return lines.join('\n')
      }
    } catch (e) { /* fall through */ }
    return text
  }

  function fmtRerank(text, documents, asJson) {
    if (asJson) return text
    try {
      const data = JSON.parse(text)
      const results = Array.isArray(data) ? data : (data && (data.results || data.data))
      if (Array.isArray(results)) {
        const lines = []
        for (const r of results) {
          if (!r || typeof r !== 'object') continue
          const idx = r.index !== undefined ? Number(r.index) : 0
          const score = r.relevance_score !== undefined ? r.relevance_score : r.score
          let t = (r.document && r.document.text) || (documents && documents[idx]) || ''
          if (typeof t === 'string' && t.length > 200) t = t.slice(0, 200) + '...'
          lines.push('[' + (typeof score === 'number' ? score.toFixed(4) : String(score)) + '] ' + t)
        }
        if (lines.length > 0) return lines.join('\n')
      }
    } catch (e) { /* fall through */ }
    return text
  }

  function fmtClassify(text, asJson) {
    if (asJson) return text
    try {
      const data = JSON.parse(text)
      const items = Array.isArray(data) ? data : (data && (data.data || data.results))
      if (Array.isArray(items)) {
        const lines = []
        for (const item of items) {
          if (!item || typeof item !== 'object') continue
          const pred = item.prediction !== undefined ? item.prediction : (Array.isArray(item.predictions) && item.predictions[0] !== undefined ? item.predictions[0] : '')
          const score = item.score !== undefined ? item.score : item.confidence
          lines.push(String(pred) + (typeof score === 'number' ? ' (' + score.toFixed(4) + ')' : ''))
        }
        if (lines.length > 0) return lines.join('\n')
      }
    } catch (e) { /* fall through */ }
    return text
  }

  /** The parsed `extract-pdf` payload, or undefined when the body is not JSON. */
  function pdfPayload(text) {
    try {
      const data = JSON.parse(text)
      return data !== null && typeof data === 'object' ? data : undefined
    } catch (err) { return undefined }
  }

  /**
   * The model-facing inventory of one `extract-pdf` payload.
   *
   * The API reports detected "floats" — LaTeX's word for figures/tables, i.e.
   * the elements that float out of the text flow. Each one carries a cropped
   * image plus `type`/`number`/`page`/`caption`; the caption is a placeholder
   * ("Table (detected)"), so the inventory is orientation only and the real
   * payload is the image.
   */
  function pdfEnvelope(data, attached) {
    const meta = data && data.meta ? data.meta : {}
    const floats = data && Array.isArray(data.floats) ? data.floats : []
    const lines = [
      'Pages: ' + (meta.num_pages !== undefined ? meta.num_pages : '?'),
      'Extracted items: ' + (meta.num_floats !== undefined ? meta.num_floats : floats.length),
    ]
    floats.forEach((f, index) => {
      if (!f || typeof f !== 'object') return
      const parts = [f.type || 'unknown']
      if (f.number) parts.push(String(f.number))
      const size = f.width && f.height ? ', ' + f.width + 'x' + f.height + ' px' : ''
      lines.push('  [' + parts.join(' ') + '] page ' + (f.page !== undefined ? f.page : '?') + size)
      if (f.caption) lines.push('    ' + String(f.caption))
      const attachedNow = attached.has(index)
      if (typeof f.image === 'string' && f.image !== '' && !attachedNow) {
        lines.push('    (image not attached — see the notes below)')
      }
    })
    return lines.join('\n')
  }

  /** A stable, descriptive name for one extracted image attachment. */
  function pdfImageName(float, index) {
    const kind = typeof float.type === 'string' && float.type !== '' ? float.type : 'item'
    const number = float.number !== undefined && float.number !== '' ? '-' + String(float.number) : '-' + (index + 1)
    const page = float.page !== undefined ? '-page' + String(float.page) : ''
    return 'jina-pdf-' + kind + number + page + '.png'
  }

  /**
   * Turn the payload's base64 crops into image blocks the model can actually see.
   *
   * `extract-pdf` returns each detected figure/table/equation as a cropped PNG
   * (base64) and nothing else — no markdown, no LaTeX, no real caption — so
   * dropping the images would leave a useless inventory. They are handed to the
   * attachment store and returned as image blocks, exactly the shape the
   * built-in `read_image` uses. Every refusal (no store, wrong media type, an
   * image over the deployment's limits) is reported in the notes rather than
   * thrown: one oversized figure must not lose the whole extraction.
   *
   * @returns `{ blocks, notes, attached }` — image blocks, human-readable
   *   refusals, and the indices of the floats that made it into `blocks`.
   */
  async function pdfImageBlocks(data, maxImages) {
    const store = ctx.get('attachments')
    const floats = data && Array.isArray(data.floats) ? data.floats : []
    const wanted = floats
      .map((f, index) => ({ f, index }))
      .filter(({ f }) => f && typeof f === 'object' && typeof f.image === 'string' && f.image !== '')
    const blocks = []
    const notes = []
    const attached = new Set()
    if (wanted.length === 0) return { blocks, notes, attached }
    if (store === undefined || store === null) {
      notes.push('the deployment has no attachment store, so the ' + wanted.length + ' extracted image(s) could not be attached')
      return { blocks, notes, attached }
    }
    const limits = store.imageLimits !== null && typeof store.imageLimits === 'object' ? store.imageLimits : {}
    const mediaTypes = Array.isArray(limits.mediaTypes) ? limits.mediaTypes : ['image/png']
    if (!mediaTypes.includes('image/png')) {
      notes.push('this deployment does not accept image/png attachments, so the extracted images were skipped')
      return { blocks, notes, attached }
    }
    const perMessage = Number.isFinite(limits.maxImagesPerMessage) ? limits.maxImagesPerMessage : wanted.length
    const asked = Number(maxImages)
    const cap = Math.max(1, Math.min(Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : PDF_DEFAULT_IMAGES, perMessage))
    for (const { f, index } of wanted) {
      if (blocks.length >= cap) {
        notes.push('only the first ' + cap + ' image(s) were attached; ' + (wanted.length - blocks.length) + ' more are in the payload (raise maxImages to attach more)')
        break
      }
      let bytes
      try { bytes = Buffer.from(String(f.image), 'base64') } catch (err) { bytes = undefined }
      if (bytes === undefined || bytes.length === 0) {
        notes.push('item ' + (index + 1) + ': the image data could not be decoded')
        continue
      }
      try {
        const ref = await store.saveImage({ data: new Uint8Array(bytes), mediaType: 'image/png', name: pdfImageName(f, index) })
        blocks.push({
          type: 'image',
          attachment: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
          },
        })
        attached.add(index)
      } catch (err) {
        notes.push('item ' + (index + 1) + ' (page ' + (f.page !== undefined ? f.page : '?') + '): ' + String((err && err.message) || err))
      }
    }
    return { blocks, notes, attached }
  }


  // ---- tool registration ---------------------------------------------------
  // IMPORTANT: `tools.register` forwards `parameters` verbatim to the model API.
  // It must therefore be a full JSON Schema object ({ type: 'object',
  // properties, required, additionalProperties }) — NOT the defineTool-style
  // per-property map ({ field: { type, required: true } }), which the model
  // server rejects ("schema must be a JSON Schema of 'type: \"object\"'").
  const OUT = {
    schema: { type: 'string' },
    render(_args, value) { return [{ type: 'text', text: value }] },
  }

  /**
   * `jina_pdf`'s output contract: a text envelope plus the extracted images.
   *
   * `extract-pdf` answers with each detected figure/table/equation as a cropped
   * base64 PNG — the image *is* the payload, since `caption` is a placeholder
   * and there is no markdown/LaTeX field at all. So the crops ride along as real
   * image blocks (the same `{ type: 'image', attachment }` shape the built-in
   * `read_image` returns) instead of being dropped on the floor.
   */
  const PDF_OUT = {
    schema: { type: 'object' },
    render(_args, value) { return value.blocks },
  }

  /** Read one key from arguments the model may have sent as anything at all. */
  const argAt = (args, key) => (args !== null && typeof args === 'object' ? args[key] : undefined)

  /** The keys the model actually sent, for an argument-error message. */
  function argsReceived(args) {
    if (args === null || typeof args !== 'object') return args === undefined ? 'nothing' : typeof args
    const keys = Object.keys(args)
    return keys.length === 0 ? 'no arguments' : keys.join(', ')
  }

  /**
   * Reject a missing or blank required string argument before it reaches the API.
   *
   * `ctx.tools.register` forwards `parameters` to the model API but never
   * enforces it — only the first-party `defineTool` path runs the argument
   * validator — so a key the model got wrong arrives here untouched. Without
   * this guard `String(args.query)` quietly turns a missing query into the
   * search term `undefined`, and Jina dutifully answers with MDN's `undefined`
   * page: a well-formed, `isError: false` result that reads exactly like a real
   * search (observed live — the model had sent `queries` instead of `query`).
   *
   * Throwing (rather than returning an error string) is deliberate: only a
   * thrown error becomes `isError: true`, the one shape that reliably stops the
   * model from treating junk as data.
   * @param name - tool name, quoted into the message.
   * @param args - raw model arguments.
   * @param key - the required property name.
   * @param aliases - names a caller may have used by mistake, reported as a hint.
   * @returns nothing when the value is a non-blank string; otherwise throws.
   */
  function requireStringArg(name, args, key, aliases) {
    const value = argAt(args, key)
    if (typeof value === 'string' && value.trim() !== '') return
    const got = value === undefined ? 'nothing' : '(' + typeof value + ') ' + JSON.stringify(value)
    const typo = (aliases || []).find((alias) => argAt(args, alias) !== undefined)
    throw new Error('invalid arguments: ' + name + ' requires a non-empty "' + key + '" string, but got ' + got
      + (typo === undefined ? '' : ' — did you mean "' + key + '" instead of "' + typo + '"?')
      + ' (arguments received: ' + argsReceived(args) + ')')
  }

  /**
   * Reject a missing, empty or non-string required string-array argument.
   * Same contract and same reasoning as {@link requireStringArg}.
   * @param name - tool name, quoted into the message.
   * @param args - raw model arguments.
   * @param key - the required property name.
   * @returns nothing when the value is a non-empty array of strings; otherwise throws.
   */
  function requireStringArrayArg(name, args, key) {
    const value = argAt(args, key)
    if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) return
    const got = value === undefined
      ? 'nothing'
      : Array.isArray(value)
        ? 'an array of ' + value.length + ' entries, not all strings'
        : '(' + typeof value + ') ' + JSON.stringify(value)
    throw new Error('invalid arguments: ' + name + ' requires a non-empty array of strings in "' + key + '", but got ' + got
      + ' (arguments received: ' + argsReceived(args) + ')')
  }

  /**
   * Reject a missing or non-http(s) required URL argument.
   * Same contract and same reasoning as {@link requireStringArg}: a returned
   * string is a *successful* result the model may read as data, so an argument
   * the model got wrong must throw instead.
   * @param name - tool name, quoted into the message.
   * @param args - raw model arguments.
   * @param key - the required property name.
   * @param aliases - names a caller may have used by mistake, reported as a hint.
   * @returns nothing when the value is an http(s) URL string; otherwise throws.
   */
  function requireUrlArg(name, args, key, aliases) {
    const value = argAt(args, key)
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return
    const got = value === undefined ? 'nothing' : '(' + typeof value + ') ' + JSON.stringify(value)
    const typo = (aliases || []).find((alias) => argAt(args, alias) !== undefined)
    throw new Error('invalid arguments: ' + name + ' requires an http(s) "' + key + '" string, but got ' + got
      + (typo === undefined ? '' : ' — did you mean "' + key + '" instead of "' + typo + '"?')
      + ' (arguments received: ' + argsReceived(args) + ')')
  }

  /** Shared executor for the search tools (jina_web_search / jina_search_arxiv / jina_search_ssrn). */
  async function runSearch(args, exec, fixedType) {
    const name = fixedType === 'arxiv' ? 'jina_search_arxiv' : fixedType === 'ssrn' ? 'jina_search_ssrn' : 'jina_web_search'
    requireStringArg(name, args, 'query', ['queries', 'q'])
    const signal = enterExec(exec)
    const body = { q: String(args.query) }
    const t = fixedType || args.type
    if (t === 'arxiv') body.domain = 'arxiv'
    else if (t === 'ssrn') body.domain = 'ssrn'
    else if (t === 'images') body.type = 'images'
    else if (t === 'blog') body.q = 'site:jina.ai/news ' + String(args.query)
    if (args.num !== undefined) body.num = args.num
    if (args.time) body.tbs = 'qdr:' + args.time
    if (args.location) body.location = args.location
    if (args.gl) body.gl = args.gl
    if (args.hl) body.hl = args.hl
    const res = await callJina({
      url: SEARCH, method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body, timeoutMs: 60000, needsKey: true, apiKey: args.apiKey, signal,
    })
    if (!res.ok) return failJina(res)
    return withKeyNote(fmtSearch(res.text, args.json === true), res, args.json === true)
  }

  ctx.tools.register({
    ...WEB_SEARCH_TOOL,
    output: OUT,
    async execute(args, exec) {
      return runSearch(args, exec)
    },
  })

  ctx.tools.register({
    name: 'jina_search_arxiv',
    description: 'Search academic papers and preprints on arXiv via Jina. Use this whenever the user asks for computer science, machine learning, mathematics, physics or other quantitative research papers, surveys or preprints. Results are canonical arxiv.org paper links with accurate snippets.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search query: paper title, topic or keywords.' },
        num: { type: 'number', description: 'Number of results. Default: 5.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of formatted results.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['query'],
    },
    output: OUT,
    async execute(args, exec) {
      return runSearch(args, exec, 'arxiv')
    },
  })

  ctx.tools.register({
    name: 'jina_search_ssrn',
    description: 'Search academic papers on SSRN (Social Science Research Network) via Jina. Use this whenever the user asks for economics, finance, law, management or other social-science working papers and publications. Results are canonical papers.ssrn.com links with accurate snippets.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search query: paper title, topic or keywords.' },
        num: { type: 'number', description: 'Number of results. Default: 5.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of formatted results.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['query'],
    },
    output: OUT,
    async execute(args, exec) {
      return runSearch(args, exec, 'ssrn')
    },
  })

  /**
   * Unwrap a Reader JSON payload.
   *
   * Every read now asks for `Accept: application/json` — that is what carries
   * the title, the post-redirect URL and the token usage. A shape surprise must
   * never lose the body, so an unparsable response comes back as `content`.
   */
  function readPayload(text) {
    const raw = typeof text === 'string' ? text : ''
    try {
      const parsed = JSON.parse(raw)
      const d = parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed
      if (d && typeof d === 'object') {
        return {
          title: typeof d.title === 'string' ? d.title : '',
          url: typeof d.url === 'string' ? d.url : '',
          published: typeof d.publishedTime === 'string' ? d.publishedTime : '',
          content: typeof d.content === 'string' ? d.content : '',
        }
      }
    } catch (err) { /* not JSON — fall through to the raw body */ }
    return { title: '', url: '', published: '', content: raw }
  }

  /** Token accounting, appended when the payload reports usage. */
  function usageFooter(text) {
    try {
      const parsed = JSON.parse(text)
      const usage = (parsed && parsed.usage) || (parsed && parsed.data && parsed.data.usage)
      if (usage && typeof usage === 'object') {
        const parts = Object.keys(usage)
          .filter((k) => typeof usage[k] === 'number')
          .map((k) => k + '=' + usage[k])
        if (parts.length > 0) return '\n\n[Usage: ' + parts.join(', ') + ']'
      }
    } catch (err) { /* nothing to report */ }
    return ''
  }

  /** jina-ocr-v1's documented output cap (`max_new_tokens=4096`). */
  const OCR_OUTPUT_CAP = 4096
  /** Pages a bare `jina_read_pdf` call covers before the caller asks for more. */
  const PDF_DEFAULT_PAGES = 5
  /** Hard ceiling on `maxPages`: one call must not be able to drain an account. */
  const PDF_MAX_PAGES = 50
  /** Extracted images a bare `jina_pdf` call attaches to the result. */
  const PDF_DEFAULT_IMAGES = 5

  /** Whether a URL looks like a PDF (path ends in `.pdf`, ignoring query/hash). */
  function isPdfUrl(value) {
    const raw = String(value === undefined || value === null ? '' : value).trim()
    if (raw === '') return false
    let path = raw
    try { path = new URL(raw).pathname } catch (err) { path = raw.split(/[?#]/)[0] }
    return /\.pdf$/i.test(path)
  }

  /** Whether a 422 body says the target selector matched nothing. */
  function selectorMismatch(res) {
    return /with target selector/i.test(String(res && res.text !== undefined ? res.text : ''))
  }

  /**
   * The page numbers one `jina_read_pdf` call reads.
   *
   * `spec` is 1-indexed and accepts `3`, `1-5` or `2,4,7`. Anything unparsable
   * falls back to the default range instead of throwing — a model that wrote
   * "pages 1 to 3" should still get its pages.
   */
  function planPages(spec, maxPages) {
    const wanted = Number(maxPages)
    const cap = Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.floor(wanted), PDF_MAX_PAGES) : PDF_DEFAULT_PAGES
    const pages = []
    const push = (n) => {
      if (Number.isInteger(n) && n >= 1 && n <= PDF_MAX_PAGES && pages.indexOf(n) === -1) pages.push(n)
    }
    if (typeof spec === 'string' && spec.trim() !== '') {
      for (const part of spec.split(',')) {
        const piece = part.trim()
        if (piece === '') continue
        const range = piece.match(/^(\d+)\s*[-–~]\s*(\d+)$/)
        if (range) {
          for (let n = Number(range[1]); n <= Number(range[2]) && pages.length < PDF_MAX_PAGES; n++) push(n)
          continue
        }
        push(Number(piece))
      }
    }
    if (pages.length === 0) for (let n = 1; n <= cap; n++) push(n)
    return pages.sort((a, b) => a - b)
  }

  /** The numeric `usage` object one Reader payload reports, or undefined. */
  function readerUsage(text) {
    try {
      const parsed = JSON.parse(text)
      const usage = (parsed && parsed.usage) || (parsed && parsed.data && parsed.data.usage)
      if (usage !== null && typeof usage === 'object') return usage
    } catch (err) { /* not JSON */ }
    return undefined
  }

  /**
   * The provenance marker a generative pipeline earns.
   *
   * `jina-ocr-v1` does not extract text — it *produces* it, so its output can
   * silently differ from the page (measured: the same arXiv paper came back
   * correct as a PDF and wholly fabricated as HTML). Saying so inside the
   * result is the cheapest guard there is: the model reading it can choose to
   * verify instead of quoting it as fact.
   */
  function pipelineNote(pipeline) {
    if (pipeline === 'jina-ocr-v1') {
      return '\n\n[Reader pipeline: jina-ocr-v1 — a generative document model transcribed this page image. Numbers, names and tables can be misread or invented; verify anything load-bearing against the source.]'
    }
    return ''
  }

  ctx.tools.register({
    name: 'jina_read',
    description: 'Read a web page as clean markdown via Jina Reader (r.jina.ai), mirroring the jina-cli \'read\' command. Uses the vendor\'s `agent` preset, resolves relative links against the post-redirect URL, and strips page chrome by default. Works without an API key (rate-limited). For a scanned / image-only PDF use jina_read_pdf; for a PDF with a text layer this tool is the cheaper and verbatim path.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Page URL, starting with http:// or https://.' },
        targetSelector: { type: 'string', description: 'CSS selector(s) to keep instead of the whole page (overrides the configured default list).' },
        waitForSelector: { type: 'string', description: 'CSS selector to wait for before extracting (dynamically rendered pages).' },
        removeSelector: { type: 'string', description: 'CSS selector(s) to drop before extracting (overrides the configured default list).' },
        noCache: { type: 'boolean', description: 'Bypass the Jina cache and fetch the page fresh.' },
        links: { type: 'boolean', description: 'Include hyperlinks in the output.' },
        images: { type: 'boolean', description: 'Include image summaries in the output.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of the extracted markdown.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['url'],
    },
    output: OUT,
    async execute(args, exec) {
      requireUrlArg('jina_read', args, 'url', ['uri', 'link', 'href'])
      const signal = enterExec(exec)
      const defaults = toolSettings()
      const key = args.apiKey || await loadKey()
      // Alt-text generation is key-gated: supplying a key is what makes a read
      // billable, so it is sent only when the user opted in AND a key exists.
      const useAltText = defaults.autoAltText === true && key !== undefined
      const selectorsOn = defaults.useSelectors !== false

      /** Build one request's headers; the retry flips `withSelectors` off. */
      const buildHeaders = (withSelectors) => {
        const headers = {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Md-Link-Style': 'discarded',
          'X-Preset': READER_PRESET,
          'X-Base': READER_BASE,
          'X-Timeout': String(READER_TIMEOUT_SECONDS),
          'X-Retain-Images': defaults.imagePolicy,
        }
        if (args.links) headers['X-With-Links-Summary'] = 'all'
        if (args.images) headers['X-With-Images-Summary'] = 'true'
        if (useAltText) headers['X-With-Generated-Alt'] = 'true'
        if (args.noCache) headers['X-No-Cache'] = 'true'
        if (withSelectors) {
          const target = args.targetSelector || defaults.targetSelector || DEFAULT_TARGET_SELECTORS
          const wait = args.waitForSelector || defaults.waitForSelector
          const remove = args.removeSelector || defaults.removeSelector || DEFAULT_REMOVE_SELECTORS
          if (target !== '') headers['X-Target-Selector'] = target
          if (wait !== '') headers['X-Wait-For-Selector'] = wait
          if (remove !== '') headers['X-Remove-Selector'] = remove
        }
        return headers
      }

      const request = (headers) => callJina({
        url: READER, method: 'POST', headers,
        body: { url: String(args.url) }, timeoutMs: 120000,
        needsKey: useAltText, apiKey: args.apiKey, signal,
      })

      let res = await request(buildHeaders(selectorsOn))
      let content = res.ok ? readPayload(res.text).content : ''
      // A target selector that matches nothing returns an empty (or near-empty)
      // page. Retry once without the selector group and keep the longer body:
      // the group is a default, never a trap.
      if (selectorsOn && res.ok && content.length < SELECTOR_RETRY_MIN_CHARS) {
        const retry = await request(buildHeaders(false))
        const retryContent = retry.ok ? readPayload(retry.text).content : ''
        if (retry.ok && retryContent.length > content.length) {
          res = retry
          content = retryContent
        }
      }
      // The same "selector matched nothing" failure has a second shape: the
      // Reader answers 422 with the selector in the message instead of coming
      // back short. The group is a default, never a trap, so retry once without
      // it instead of telling the model its arguments are invalid.
      if (!res.ok && res.status === 422 && selectorsOn && selectorMismatch(res)) {
        const retry = await request(buildHeaders(false))
        if (retry.ok) {
          res = retry
          content = readPayload(retry.text).content
        }
      }
      if (!res.ok) return failJina(res)
      if (args.json) return res.text
      if (content === '') return res.text
      const payload = readPayload(res.text)
      let out = content
      if (payload.title !== '' && out.indexOf(payload.title) === -1) {
        out = 'Title: ' + payload.title
          + '\nURL Source: ' + (payload.url !== '' ? payload.url : String(args.url))
          + (payload.published !== '' ? '\nPublished Time: ' + payload.published : '')
          + '\n\nMarkdown Content:\n' + out
      }
      return out + usageFooter(res.text) + keySwitchNote(res)
    },
  })

  ctx.tools.register({
    name: 'jina_read_pdf',
    description: 'Read a PDF as Markdown through jina-ocr-v1, Jina\'s 3.4B document-OCR model — the pipeline that works on scanned / image-only PDFs, where jina_read returns almost nothing. The Reader renders each page to an image and the model transcribes it, so pages are requested ONE AT A TIME (the API silently serves page 1 again when asked for a page past the end, which is how this tool detects the end). Try jina_read first: a PDF with a text layer is verbatim and ~40x cheaper there. Costs ~40x the plain extractor\'s tokens.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'PDF URL (https). Must look like a PDF unless allowNonPdf is set.' },
        pages: { type: 'string', description: 'Pages to read, 1-indexed: "3", "1-5" or "2,4,7". Default: the first maxPages pages.' },
        maxPages: { type: 'number', description: 'How many pages the default range covers. Default: 5. Hard cap: 50.' },
        allowNonPdf: { type: 'boolean', description: 'Read a URL that does not look like a PDF anyway. OCR on ordinary web pages can fabricate content — prefer jina_read there.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['url'],
    },
    output: OUT,
    async execute(args, exec) {
      requireUrlArg('jina_read_pdf', args, 'url', ['uri', 'link', 'href'])
      const signal = enterExec(exec)
      const url = String(args.url)
      if (!isPdfUrl(url) && args.allowNonPdf !== true) {
        throw new Error('jina_read_pdf expects a PDF URL: "' + url + '" does not end in .pdf. '
          + 'jina-ocr-v1 is a document model — it reads one rendered page image per call, and on ordinary web pages it is known to invent text it cannot read. '
          + 'Use jina_read for web pages, or pass allowNonPdf: true if this URL really is a PDF.')
      }
      const key = args.apiKey || await loadKey()
      if (!key) {
        throw new Error('jina_read_pdf requires a Jina API key: the Reader rejects jina-ocr-v1 for anonymous callers (HTTP 401, '
          + '"Authentication is required to use this feature (Vision Language Model / OCR)"). '
          + 'Save a key in the Plugins → dsh-jina card, or pass apiKey.')
      }
      const defaults = toolSettings()
      const pages = planPages(args.pages, args.maxPages)
      const sections = []
      const warnings = []
      const seen = new Map()
      let title = ''
      let source = url
      let stopped = ''
      let scaled = 0
      let switchNote = ''
      for (const page of pages) {
        const res = await callJina({
          url: READER, method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Md-Link-Style': 'discarded',
            'X-Preset': READER_PRESET,
            'X-Base': READER_BASE,
            'X-Timeout': String(READER_TIMEOUT_SECONDS),
            'X-Retain-Images': defaults.imagePolicy,
            'X-Respond-With': 'jina-ocr-v1',
            'X-Page': String(page),
          },
          body: { url }, timeoutMs: 120000, needsKey: true, apiKey: args.apiKey, signal,
        })
        if (!res.ok) {
          // A first page that fails is the whole call failing; a later page that
          // fails only truncates the result, so keep what was read and say so.
          if (sections.length === 0) return failJina(res)
          warnings.push('page ' + page + ': ' + describeJinaError(res).split('\n')[0])
          stopped = 'page ' + page + ' failed'
          break
        }
        switchNote = switchNote || keySwitchNote(res)
        const payload = readPayload(res.text)
        if (title === '' && payload.title !== '') title = payload.title
        if (payload.url !== '') source = payload.url
        const usage = readerUsage(res.text)
        if (usage && typeof usage.scaledTokens === 'number') scaled += usage.scaledTokens
        const text = payload.content.trim()
        if (text === '' || text.toLowerCase() === 'null') {
          stopped = 'page ' + page + ' came back empty'
          break
        }
        const fingerprint = text.replace(/\s+/g, ' ').slice(0, 4000)
        if (seen.has(fingerprint)) {
          // Verified against the live API: an out-of-range X-Page silently
          // returns page 1 again, so a repeat is the end-of-document signal.
          stopped = 'page ' + page + ' repeated page ' + seen.get(fingerprint) + ' (past the end of the document)'
          break
        }
        seen.set(fingerprint, page)
        if (usage && usage.outputTokens === OCR_OUTPUT_CAP) {
          warnings.push('page ' + page + ' hit the model output cap (' + OCR_OUTPUT_CAP + ' tokens): it may be truncated, or a degenerate repetition')
        }
        sections.push('## Page ' + page + '\n\n' + text)
      }
      if (sections.length === 0) return '(no page could be read)'
      const head = (title !== '' ? 'Title: ' + title + '\n' : '') + 'URL Source: ' + source + '\n\n'
      const meta = '[jina_read_pdf: ' + sections.length + ' page(s) via jina-ocr-v1'
        + (scaled > 0 ? ', ' + scaled + ' tokens billed' : '')
        + (stopped !== '' ? '; stopped because ' + stopped : '')
        + ']'
      const tail = warnings.length > 0 ? '\n\n[Warnings]\n' + warnings.map((w) => '- ' + w).join('\n') : ''
      return head + meta + '\n\n' + sections.join('\n\n') + pipelineNote('jina-ocr-v1') + tail + switchNote
    },
  })

  ctx.tools.register({
    name: 'jina_screenshot',
    description: 'Capture a screenshot of a web page via Jina (r.jina.ai), mirroring the jina-cli \'screenshot\' command. Returns the hosted screenshot URL.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Page URL, starting with http:// or https://.' },
        fullPage: { type: 'boolean', description: 'Capture the full page instead of the viewport.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['url'],
    },
    output: OUT,
    async execute(args, exec) {
      requireUrlArg('jina_screenshot', args, 'url', ['uri', 'link', 'href'])
      const signal = enterExec(exec)
      const res = await callJina({
        url: READER, method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Return-Format': args.fullPage ? 'pageshot' : 'screenshot' },
        body: { url: String(args.url) }, timeoutMs: 120000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return failJina(res)
      return fmtScreenshot(res.text) + keySwitchNote(res)
    },
  })

  ctx.tools.register({
    name: 'jina_datetime',
    description: 'Guess the publish/update datetime of a URL via Jina (r.jina.ai), mirroring the jina-cli \'datetime\' command. Works without an API key.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Page URL, starting with http:// or https://.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of the extracted title/datetime.' },
      },
      required: ['url'],
    },
    output: OUT,
    async execute(args, exec) {
      requireUrlArg('jina_datetime', args, 'url', ['uri', 'link', 'href'])
      const signal = enterExec(exec)
      const res = await callJina({
        url: READER, method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Return-Format': 'datetime' },
        body: { url: String(args.url) }, timeoutMs: 60000, needsKey: false, signal,
      })
      if (!res.ok) return failJina(res)
      return withKeyNote(fmtDatetime(res.text, args.json === true), res, args.json === true)
    },
  })

  ctx.tools.register({
    name: 'jina_expand',
    description: 'Expand a search query into related queries via Jina, mirroring the jina-cli \'expand\' command.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The query to expand.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of formatted queries.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['query'],
    },
    output: OUT,
    async execute(args, exec) {
      requireStringArg('jina_expand', args, 'query', ['queries', 'q'])
      const signal = enterExec(exec)
      const res = await callJina({
        url: SEARCH, method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: { q: String(args.query), query_expansion: true }, timeoutMs: 60000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return failJina(res)
      return withKeyNote(fmtExpand(res.text, args.json === true), res, args.json === true)
    },
  })

  ctx.tools.register({
    name: 'jina_embed',
    description: 'Generate embeddings for texts via Jina Embeddings API, mirroring the jina-cli \'embed\' command. Default model: jina-embeddings-v5-text-small.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        texts: { type: 'array', items: { type: 'string' }, description: 'Texts to embed (up to a few hundred).' },
        model: { type: 'string', description: 'Embedding model. Default: jina-embeddings-v5-text-small.' },
        task: { type: 'string', description: 'Embedding task type. Default: text-matching.' },
        dimensions: { type: 'number', description: 'Optional output dimensions (Matryoshka).' },
        json: { type: 'boolean', description: 'Return the raw JSON response (full vectors) instead of a preview.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['texts'],
    },
    output: OUT,
    async execute(args, exec) {
      requireStringArrayArg('jina_embed', args, 'texts')
      const signal = enterExec(exec)
      const body = { model: args.model || 'jina-embeddings-v5-text-small', task: args.task || 'text-matching', input: args.texts }
      if (args.dimensions !== undefined) body.dimensions = args.dimensions
      const res = await callJina({
        url: API + '/v1/embeddings', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body, timeoutMs: 90000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return failJina(res)
      return withKeyNote(fmtEmbed(res.text, args.json === true), res, args.json === true)
    },
  })

  ctx.tools.register({
    name: 'jina_rerank',
    description: 'Rerank documents by relevance to a query via Jina Reranker API, mirroring the jina-cli \'rerank\' command. Default model: jina-reranker-v3.5.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The reference query.' },
        documents: { type: 'array', items: { type: 'string' }, description: 'Documents (strings) to rerank.' },
        topN: { type: 'number', description: 'Maximum number of results to return.' },
        model: { type: 'string', description: 'Reranker model. Default: jina-reranker-v3.5.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of formatted results.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['query', 'documents'],
    },
    output: OUT,
    async execute(args, exec) {
      requireStringArg('jina_rerank', args, 'query', ['queries', 'q'])
      requireStringArrayArg('jina_rerank', args, 'documents')
      const signal = enterExec(exec)
      const body = { model: args.model || 'jina-reranker-v3.5', query: String(args.query), documents: args.documents }
      if (args.topN !== undefined) body.top_n = args.topN
      const res = await callJina({
        url: API + '/v1/rerank', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body, timeoutMs: 90000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return failJina(res)
      return withKeyNote(fmtRerank(res.text, args.documents, args.json === true), res, args.json === true)
    },
  })

  ctx.tools.register({
    name: 'jina_classify',
    description: 'Classify texts into labels via Jina Classify API, mirroring the jina-cli \'classify\' command. Default model: jina-embeddings-v5-text-small.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        texts: { type: 'array', items: { type: 'string' }, description: 'Texts to classify.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Candidate labels.' },
        model: { type: 'string', description: 'Embedding model used for classification. Default: jina-embeddings-v5-text-small.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of formatted predictions.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['texts', 'labels'],
    },
    output: OUT,
    async execute(args, exec) {
      requireStringArrayArg('jina_classify', args, 'texts')
      requireStringArrayArg('jina_classify', args, 'labels')
      const signal = enterExec(exec)
      const body = { model: args.model || 'jina-embeddings-v5-text-small', input: args.texts, labels: args.labels }
      const res = await callJina({
        url: API + '/v1/classify', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body, timeoutMs: 90000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return failJina(res)
      return withKeyNote(fmtClassify(res.text, args.json === true), res, args.json === true)
    },
  })

  ctx.tools.register({
    name: 'jina_pdf',
    description: 'Extract the figures, tables and equations of a PDF via Jina (extract-pdf), mirroring the jina-cli \'pdf\' command, and attach each extracted crop to the result as an image. This is a VISUAL extractor: it returns no text, no markdown and no LaTeX, and its caption is a placeholder — use jina_read_pdf when you need the document\'s words. Provide either url or arxivId.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'PDF URL (https). Only allowlisted sources are accepted — most hosts answer HTTP 400 "not an allowed PDF source".' },
        arxivId: { type: 'string', description: 'arXiv paper ID shorthand, e.g. 2301.12345. The reliable way to reach this endpoint.' },
        extractType: { type: 'string', description: 'Filter by type: figure, table, equation (comma-separated).' },
        maxEdge: { type: 'number', description: 'Max pixel size for extracted images. Default: 1024.' },
        maxImages: { type: 'number', description: 'How many extracted crops to attach as images. Default: 5.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of the inventory (no image blocks).' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
    },
    output: PDF_OUT,
    async execute(args, exec) {
      const signal = enterExec(exec)
      const body = { max_edge: args.maxEdge !== undefined ? args.maxEdge : 1024 }
      if (args.arxivId) body.id = String(args.arxivId)
      else if (args.url) body.url = String(args.url)
      else throw new Error('invalid arguments: jina_pdf requires either a "url" or an "arxivId" (arguments received: ' + argsReceived(args) + ')')
      if (args.extractType) body.type = args.extractType
      const res = await callJina({
        url: SEARCH + 'extract-pdf', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body, timeoutMs: 120000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return failJina(res)
      if (args.json === true) return { blocks: [{ type: 'text', text: withKeyNote(res.text, res, true) }] }
      const data = pdfPayload(res.text)
      if (data === undefined) return { blocks: [{ type: 'text', text: withKeyNote(res.text, res, false) }] }
      const extracted = await pdfImageBlocks(data, args.maxImages)
      let text = pdfEnvelope(data, extracted.attached)
      if (extracted.blocks.length > 0) {
        text += '\n\n' + extracted.blocks.length + ' extracted image(s) are attached below — those crops are the figures/tables themselves.'
      }
      if (extracted.notes.length > 0) text += '\n\n[Notes]\n' + extracted.notes.map((note) => '- ' + note).join('\n')
      return { blocks: [{ type: 'text', text: withKeyNote(text, res, false) }, ...extracted.blocks] }
    },
  })

  ctx.tools.register({
    name: 'jina_primer',
    description: 'Get current context for time/location-aware answers: host clock (ISO time, unix, timezone, UTC offset), network facts (public IP and location, best-effort via ipinfo.io), and Jina account status (authenticated identity + credit balance from r.jina.ai). Sections that cannot be fetched are reported as unavailable; the tool never throws. Works without an API key.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        json: { type: 'boolean', description: 'Return the raw JSON data object instead of formatted text.' },
      },
    },
    output: OUT,
    async execute(args, exec) {
      const signal = enterExec(exec)
      const now = new Date()
      // Best-effort parallel probes; one failing section must not fail the tool.
      const [jinaRes, ipRes] = await Promise.all([
        callJina({
          url: READER, method: 'GET',
          headers: { Accept: 'application/json' },
          body: undefined, timeoutMs: 60000, needsKey: false, signal,
        }),
        jinaRequest({
          url: IPINFO, method: 'GET',
          headers: { Accept: 'application/json' },
          body: undefined, timeoutMs: 10000, signal,
        }),
      ])
      const jina = jinaRes && jinaRes.ok ? parseJinaRoot(jinaRes.text) : null
      const network = ipRes && ipRes.ok ? parseIpInfo(ipRes.text) : null
      return formatPrimer(buildPrimer({ now, jina, network }), args.json === true)
    },
  })

  // ---- web settings health-check endpoint -----------------------------------
  // The Jina Tools card asks this route how many keys it holds and how many can
  // serve a call, plus the total credits behind them (jina-cli `primer`), and
  // for the proxy actually in effect. Registered when the deployment composes a
  // web server (the web profile); profiles without one simply never get the
  // route. Nothing per key leaves the host: the payload carries counts and one
  // total, never a key, its fingerprint, or its individual balance — and a key
  // that answers 401/402 or reports no credits left is discarded here, so the
  // page never has to offer the user a list to manage.

  /**
   * Probe one key against the Reader root — the same call jina-cli `primer`
   * makes. One key, one request, no rotation: the card must learn what each
   * key answers, so the pool walk would be exactly the wrong tool here.
   * @param key - the key value, or undefined for the anonymous probe.
   * @param signal - optional cancellation.
   * @returns the transport result.
   */
  function probeKey(key, signal) {
    const headers = { Accept: 'application/json' }
    if (key !== undefined && key !== null && key !== '') headers.Authorization = 'Bearer ' + String(key)
    return jinaRequest({ url: READER, method: 'GET', headers, body: undefined, timeoutMs: 30000, signal })
  }

  /**
   * The identity and balance a primer response carries.
   * @param text - the raw response body.
   * @returns `{ parsed, authenticatedAs, balanceLeft }` — `parsed` is false
   *   when the body was not the expected JSON shape.
   */
  function primerData(text) {
    try {
      const data = JSON.parse(text)
      const d = (data && typeof data === 'object' && data.data && typeof data.data === 'object') ? data.data : data
      return {
        parsed: true,
        authenticatedAs: d !== null && typeof d === 'object' && typeof d.authenticatedAs === 'string' ? d.authenticatedAs : '',
        balanceLeft: d !== null && typeof d === 'object' && typeof d.balanceLeft === 'number' ? d.balanceLeft : null,
      }
    } catch (err) {
      return { parsed: false, authenticatedAs: '', balanceLeft: null }
    }
  }

  ctx.inject(['webServer'], (rpcCtx) => {
    rpcCtx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-jina/primer',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { Allow: 'GET' })
          res.end()
          return
        }
        const pool = await loadKeyPool()
        const state = keyStateFor(pool)
        // One probe per key, in parallel: this is where the pool is kept clean.
        const probes = await Promise.all(pool.map((entry) => probeKey(entry.value)))
        const discarded = []
        const survived = []
        const counts = { keyCount: 0, balanceTotal: null }
        await Promise.all(pool.map(async (entry, index) => {
          const probe = probes[index]
          const ok = probe.ok === true
          const data = ok ? primerData(probe.text) : { authenticatedAs: '', balanceLeft: null }
          // A key that cannot serve a call is deleted, not listed: 401, 402, or
          // a healthy-looking probe that reports no credits left. Anything else
          // (a rate limit, a network failure) only parks it for a cooldown —
          // discarding a working key over a transient failure would be wrong.
          const exhausted = ok && typeof data.balanceLeft === 'number' && data.balanceLeft <= 0
          const doomed = !ok ? (probe.status === 401 || probe.status === 402) : exhausted
          if (doomed && await discardKey(entry)) discarded.push(entry)
          survived[index] = !doomed
          if (!doomed) counts.keyCount++
          if (!doomed && typeof data.balanceLeft === 'number') {
            counts.balanceTotal = (counts.balanceTotal === null ? 0 : counts.balanceTotal) + data.balanceLeft
          }
          // The card's refresh is also a health check: a key that answers here
          // updates the same rotation state the failover walk uses, so topping
          // an account up clears its cooldown without a restart.
          state.states[index] = ok ? clearKeyState() : keyStateAfter(state.states[index], probe.status, Date.now())
        }))
        // The headline probe answers "can this profile reach Jina at all" and
        // must describe a key that is still there: the first surviving key whose
        // probe worked, else the first surviving key, else — nothing left — the
        // anonymous probe.
        const okIndex = probes.findIndex((probe, index) => survived[index] === true && probe.ok === true)
        const outIndex = okIndex >= 0 ? okIndex : survived.indexOf(true)
        const out = outIndex >= 0 ? probes[outIndex] : await probeKey(undefined)
        const probed = outIndex < 0 ? undefined : pool[outIndex]
        // The page shows the pool size and one total, never anything per key and
        // never a usable/total fraction — the host discards what cannot serve a
        // call, so the count it reports is the count that matters.
        // `balanceTotal` is null when no key reported a balance, so the page can
        // say "unknown" instead of "0".
        const extra = {
          proxy: out.proxy || null,
          proxyConfigured: settingProxy(),
          settingsLive: settingsAreLive(settingsConfig),
          keyCount: counts.keyCount,
          balanceTotal: counts.balanceTotal,
          discardedCount: discarded.length,
        }
        let payload
        if (out.ok) {
          const data = primerData(out.text)
          payload = data.parsed
            ? {
                ok: true,
                status: out.status,
                authenticatedAs: data.authenticatedAs,
                balanceLeft: data.balanceLeft,
                keyFound: probed !== undefined,
                keyKind: probed === undefined ? undefined : (probed.source === 'credential' ? 'credential' : 'file'),
                ...extra,
              }
            : { ok: false, status: out.status, error: 'unexpected primer response shape', ...extra }
        } else {
          payload = { ok: false, status: out.status, error: describeJinaError(out), ...extra }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(payload))
      },
    })
  })

  // ---- web settings namespace ------------------------------------------------
  // There is nothing to register at runtime: the `jina-tools` settings
  // namespace *is* this Loader entry (the bundle's `cordis.patch.yml` contributes
  // `- id: jina-tools / name: dsh-jina`), and the module-level `Config` export
  // above is the live-field declaration the settings provider serves to the
  // browser half's configuration form. `apply` receives the resolved config (see
  // `settingsConfig`) and the loader writes a saved field straight into its
  // volatile references, so a save reaches the next operation without a restart.
  //
  // The stored document only ever holds what the user changed — defaults live in
  // proxy.js (`toolSettingsOf`) so "unset" keeps meaning "default" and a later
  // default change reaches users who never touched the field.
}
