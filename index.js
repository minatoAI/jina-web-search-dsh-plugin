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
 * settings pairing: this host half serves the `jina-tools` settings
 * namespace and the browser half registers its card for that namespace, so
 * the Settings → Plugins tab (Settings → Plugins → Configure) renders the
 * card only when the two halves agree.
 *
 * The API key is resolved per call in this order:
 *   1. the tool's own `apiKey` parameter,
 *   2. the `JINA_API_KEY` credential (set from the web settings page,
 *      persisted by the host credential provider, e.g. `.credentials.yaml`),
 *   3. `jina-api-key.txt` in the calling session's workspace,
 *   4. `jina-api-key.txt` in the dsh home directory (`$DSH_HOME` or `~/.dsh`).
 *
 * Network transport: the Jina endpoints are contacted through a small
 * `node -e` fetch helper spawned via the host `subprocess` service, with
 * NODE_USE_ENV_PROXY enabled so Node's fetch honors the system proxy (the
 * local VPN on Windows). The proxy address is discovered from the WinINET
 * registry settings before each call and rediscovered automatically when a
 * transport failure suggests the proxy port changed.
 */

import { homedir } from 'node:os'
import { buildPrimer, formatPrimer, parseIpInfo, parseJinaRoot } from './primer.js'
import { WEB_SEARCH_TOOL } from './tool-contracts.js'

export const name = 'dsh-jina'

export const inject = ['fs', 'subprocess', 'tools']

export function apply(ctx) {
  const READER = 'https://r.jina.ai/'
  const IPINFO = 'https://ipinfo.io/json'
  const SEARCH = 'https://svip.jina.ai/'
  const API = 'https://api.jina.ai'
  const KEY_FILE = 'jina-api-key.txt'
  const CRED_REF = 'JINA_API_KEY'
  const MAX_OUT = 1500000

  const HTTP_SCRIPT = [
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

  let nodePath
  let fileKeyCache = { text: undefined, at: 0 }
  let keyDiag = ''
  let keyKind
  let proxyCache = { text: undefined, at: 0, done: false }
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
   * Resolve the `JINA_API_KEY` credential. Per-operation by contract: the
   * credential seam documents that consumers re-resolve at each operation so
   * a changed credential reaches the next operation without a restart.
   * @returns the credential value, or undefined while unconfigured/absent.
   */
  async function credentialKey() {
    try {
      const svc = ctx.get('credentials')
      if (svc === undefined) return undefined
      const resolved = await svc.resolve(CRED_REF)
      return resolved && resolved.value ? resolved.value : undefined
    } catch (err) { return undefined }
  }

  /** API key: credential, then workspace file, then dsh-home file. */
  async function loadKey() {
    let value
    let kind
    const attempts = []
    try {
      const svc = ctx.get('credentials')
      if (svc === undefined) {
        attempts.push('credential service absent')
      } else {
        const resolved = await svc.resolve(CRED_REF)
        if (resolved && resolved.value) {
          value = resolved.value
          kind = 'credential'
          attempts.push('credential ' + CRED_REF + ': found (source ' + String(resolved.source) + ')')
        } else {
          attempts.push('credential ' + CRED_REF + ': not set')
        }
      }
    } catch (err) {
      attempts.push('credential ' + CRED_REF + ': ' + String((err && err.message) || err))
    }
    if (value === undefined) {
      // File sources: cached 30s; the 401 path invalidates and re-reads.
      if (fileKeyCache.text !== undefined && Date.now() - fileKeyCache.at < 30000) {
        attempts.push('file cache: hit')
        value = fileKeyCache.text
        kind = 'file'
      } else {
        const root = resolveRoot()
        const home = dshHome()
        const candidates = [
          { kind: 'workspace abs', path: root + '\\' + KEY_FILE, opts: undefined },
          { kind: 'workspace rel+cwd', path: KEY_FILE, opts: { cwd: root } },
          { kind: 'workspace rel', path: KEY_FILE, opts: undefined },
          { kind: 'home abs', path: home + '\\' + KEY_FILE, opts: undefined },
          { kind: 'home rel+cwd', path: KEY_FILE, opts: { cwd: home } },
        ]
        for (const c of candidates) {
          try {
            const target = await ctx.fs.resolve(c.path, c.opts)
            const raw = await ctx.fs.readText(target)
            const trimmed = String(raw).trim()
            if (trimmed !== '') { value = trimmed; kind = 'file'; attempts.push(c.kind + ': found'); break }
            attempts.push(c.kind + ': empty file')
          } catch (err) {
            attempts.push(c.kind + ': ' + String((err && err.message) || err))
          }
        }
        fileKeyCache = { text: value, at: Date.now() }
      }
    }
    keyDiag = 'credential ' + CRED_REF + ' | ' + attempts.join(' | ')
    keyKind = kind
    return value
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

  /** One HTTP call through the node helper. */
  async function jinaRequest(spec) {
    const node = await resolveNode()
    if (!node) return { ok: false, status: 0, text: 'node executable not found on PATH; the helper needs Node.js to make the HTTP call' }
    let proxy
    if (spec.proxy !== undefined && spec.proxy !== null && spec.proxy !== '') {
      proxy = String(spec.proxy)
      if (!/^https?:\/\//i.test(proxy)) proxy = 'http://' + proxy
    } else {
      proxy = await discoverProxy()
    }
    const payload = JSON.stringify({
      url: spec.url,
      method: spec.method || 'POST',
      headers: spec.headers || {},
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
      timeoutMs: spec.timeoutMs || 60000,
    })
    const makeEnv = (p) => {
      const env = { NODE_USE_ENV_PROXY: '1', NO_PROXY: '' }
      if (p) { env.HTTPS_PROXY = p; env.HTTP_PROXY = p }
      return env
    }
    const parse = (r) => {
      let parsed
      try { parsed = JSON.parse(r.stdout.text) } catch (e) {
        return { ok: false, status: 0, text: 'helper output not parseable: ' + String(r.stdout.text).slice(0, 300) + (r.stderr.text ? ' [stderr: ' + String(r.stderr.text).slice(0, 300) + ']' : '') }
      }
      if (typeof parsed !== 'object' || parsed === null) return { ok: false, status: 0, text: 'bad helper output: ' + String(r.stdout.text).slice(0, 300) }
      return parsed
    }
    let r = await runCollect([node, '-e', HTTP_SCRIPT], payload, MAX_OUT, makeEnv(proxy), spec.signal)
    let parsed = parse(r)
    if (parsed.ok || parsed.status !== 0) return parsed
    // Transport-level failure: rediscover the proxy (the VPN may have restarted on a new port) and retry once.
    if (spec.proxy === undefined || spec.proxy === null || spec.proxy === '') {
      proxyCache = { text: undefined, at: 0, done: false }
      const proxy2 = await discoverProxy()
      r = await runCollect([node, '-e', HTTP_SCRIPT], payload, MAX_OUT, makeEnv(proxy2), spec.signal)
      parsed = parse(r)
    }
    return parsed
  }

  /** Full call: key handling + auth header + 401 key refresh. */
  async function callJina(opts) {
    const headers = {}
    for (const k of Object.keys(opts.headers || {})) headers[k] = opts.headers[k]
    const explicit = opts.apiKey !== undefined && opts.apiKey !== null && opts.apiKey !== ''
    let key = explicit ? String(opts.apiKey) : await loadKey()
    if (key) headers.Authorization = 'Bearer ' + key
    if (opts.needsKey && !key) {
      return { ok: false, status: 401, text: 'Jina API key required for this command. Set it in the DSH settings page (Jina Tools) or put it in ' + KEY_FILE + ' in the session workspace or the dsh home directory (one line). Get a free key at https://jina.ai/?sui=apikey' + (keyDiag ? ' [key lookup: ' + keyDiag + ']' : '') }
    }
    const mk = () => ({ url: opts.url, method: opts.method || 'POST', headers, body: opts.body, timeoutMs: opts.timeoutMs, signal: opts.signal, ...(opts.proxy !== undefined ? { proxy: opts.proxy } : {}) })
    let res = await jinaRequest(mk())
    if (!res.ok && res.status === 401 && !explicit) {
      fileKeyCache = { text: undefined, at: 0 }
      const fresh = await loadKey()
      if (fresh && fresh !== key) {
        headers.Authorization = 'Bearer ' + fresh
        res = await jinaRequest(mk())
      }
    }
    return res
  }

  function describeJinaError(res) {
    const status = res.status || 0
    const body = String(res.text || '').slice(0, 800)
    const hints = {
      0: 'No response from the Jina API (network/VPN problem). Check that the local VPN and its system proxy are enabled, then retry.',
      401: 'Invalid or expired API key. Fix: update it in the DSH settings page (Jina Tools) or the key file. Get a free key: https://jina.ai/?sui=apikey',
      402: 'API quota exhausted. Fix: top up credits at https://jina.ai/api-dashboard/billing',
      422: 'Invalid request parameters.',
      429: 'Rate limit hit. Wait a few seconds and retry, or add an API key for higher limits.',
    }
    let msg = 'Jina API error (HTTP ' + status + '). ' + (hints[status] || '')
    if (status >= 500) msg = 'Jina API server error (HTTP ' + status + '). Retry in a moment; status: https://status.jina.ai'
    if (body) msg += '\nServer said: ' + body
    return msg
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

  function fmtPdf(text, asJson) {
    if (asJson) return text
    try {
      const data = JSON.parse(text)
      const meta = data && data.meta ? data.meta : {}
      const floats = data && Array.isArray(data.floats) ? data.floats : []
      const lines = []
      lines.push('Pages: ' + (meta.num_pages !== undefined ? meta.num_pages : '?'))
      lines.push('Extracted items: ' + (meta.num_floats !== undefined ? meta.num_floats : floats.length))
      for (const f of floats) {
        if (!f || typeof f !== 'object') continue
        const parts = [f.type || 'unknown']
        if (f.number) parts.push(String(f.number))
        lines.push('  [' + parts.join(' ') + '] page ' + (f.page !== undefined ? f.page : '?'))
        if (f.caption) lines.push('    ' + String(f.caption))
      }
      return lines.join('\n')
    } catch (e) { /* fall through */ }
    return text
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

  /** Shared executor for the search tools (jina_web_search / jina_search_arxiv / jina_search_ssrn). */
  async function runSearch(args, exec, fixedType) {
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
    if (!res.ok) return describeJinaError(res)
    return fmtSearch(res.text, args.json === true)
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

  ctx.tools.register({
    name: 'jina_read',
    description: 'Read a web page and extract clean markdown via Jina Reader (r.jina.ai), mirroring the jina-cli \'read\' command. Works without an API key (rate-limited); pass a key for higher limits. Use links/images to include link/image summaries.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Page URL, starting with http:// or https://.' },
        links: { type: 'boolean', description: 'Include hyperlinks in the output.' },
        images: { type: 'boolean', description: 'Include image summaries in the output.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of markdown.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['url'],
    },
    output: OUT,
    async execute(args, exec) {
      const signal = enterExec(exec)
      if (!/^https?:\/\//i.test(String(args.url))) return 'invalid url: ' + args.url + ' (must start with http:// or https://)'
      const headers = {
        Accept: args.json ? 'application/json' : 'text/markdown',
        'Content-Type': 'application/json',
        'X-Md-Link-Style': 'discarded',
      }
      if (args.links) headers['X-With-Links-Summary'] = 'all'
      if (args.images) headers['X-With-Images-Summary'] = 'true'
      else headers['X-Retain-Images'] = 'none'
      const res = await callJina({
        url: READER, method: 'POST', headers,
        body: { url: String(args.url) }, timeoutMs: 120000, needsKey: false, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return describeJinaError(res)
      return res.text
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
      const signal = enterExec(exec)
      if (!/^https?:\/\//i.test(String(args.url))) return 'invalid url: ' + args.url + ' (must start with http:// or https://)'
      const res = await callJina({
        url: READER, method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Return-Format': args.fullPage ? 'pageshot' : 'screenshot' },
        body: { url: String(args.url) }, timeoutMs: 120000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return describeJinaError(res)
      return fmtScreenshot(res.text)
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
      const signal = enterExec(exec)
      if (!/^https?:\/\//i.test(String(args.url))) return 'invalid url: ' + args.url + ' (must start with http:// or https://)'
      const res = await callJina({
        url: READER, method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Return-Format': 'datetime' },
        body: { url: String(args.url) }, timeoutMs: 60000, needsKey: false, signal,
      })
      if (!res.ok) return describeJinaError(res)
      return fmtDatetime(res.text, args.json === true)
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
      const signal = enterExec(exec)
      const res = await callJina({
        url: SEARCH, method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: { q: String(args.query), query_expansion: true }, timeoutMs: 60000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return describeJinaError(res)
      return fmtExpand(res.text, args.json === true)
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
      const signal = enterExec(exec)
      const body = { model: args.model || 'jina-embeddings-v5-text-small', task: args.task || 'text-matching', input: args.texts }
      if (args.dimensions !== undefined) body.dimensions = args.dimensions
      const res = await callJina({
        url: API + '/v1/embeddings', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body, timeoutMs: 90000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return describeJinaError(res)
      return fmtEmbed(res.text, args.json === true)
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
      const signal = enterExec(exec)
      const body = { model: args.model || 'jina-reranker-v3.5', query: String(args.query), documents: args.documents }
      if (args.topN !== undefined) body.top_n = args.topN
      const res = await callJina({
        url: API + '/v1/rerank', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body, timeoutMs: 90000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return describeJinaError(res)
      return fmtRerank(res.text, args.documents, args.json === true)
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
      const signal = enterExec(exec)
      const body = { model: args.model || 'jina-embeddings-v5-text-small', input: args.texts, labels: args.labels }
      const res = await callJina({
        url: API + '/v1/classify', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body, timeoutMs: 90000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return describeJinaError(res)
      return fmtClassify(res.text, args.json === true)
    },
  })

  ctx.tools.register({
    name: 'jina_pdf',
    description: 'Extract figures, tables and equations from a PDF via Jina (extract-pdf), mirroring the jina-cli \'pdf\' command. Provide either url or arxivId.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'PDF URL (https).' },
        arxivId: { type: 'string', description: 'arXiv paper ID shorthand, e.g. 2301.12345.' },
        extractType: { type: 'string', description: 'Filter by type: figure, table, equation (comma-separated).' },
        maxEdge: { type: 'number', description: 'Max pixel size for extracted images. Default: 1024.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of formatted output.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
    },
    output: OUT,
    async execute(args, exec) {
      const signal = enterExec(exec)
      const body = { max_edge: args.maxEdge !== undefined ? args.maxEdge : 1024 }
      if (args.arxivId) body.id = String(args.arxivId)
      else if (args.url) body.url = String(args.url)
      else return 'provide either url or arxivId (jina pdf URL_OR_ARXIV_ID)'
      if (args.extractType) body.type = args.extractType
      const res = await callJina({
        url: SEARCH + 'extract-pdf', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body, timeoutMs: 120000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return describeJinaError(res)
      return fmtPdf(res.text, args.json === true)
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
  // The Jina Tools card asks this route for the key's identity + balance
  // (jina-cli `primer`). Registered when the deployment composes a web server
  // (the web profile); profiles without one simply never get the route.
  // The API key itself never leaves the host.
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
        const key = await loadKey()
        const out = await callJina({
          url: READER, method: 'GET',
          headers: { Accept: 'application/json' },
          body: undefined, timeoutMs: 30000, needsKey: false, apiKey: key,
        })
        let payload
        if (out.ok) {
          try {
            const data = JSON.parse(out.text)
            const d = (data && typeof data === 'object' && data.data && typeof data.data === 'object') ? data.data : data
            payload = {
              ok: true,
              status: out.status,
              authenticatedAs: typeof d.authenticatedAs === 'string' ? d.authenticatedAs : '',
              balanceLeft: typeof d.balanceLeft === 'number' ? d.balanceLeft : null,
              keyFound: key !== undefined,
              keyKind: keyKind,
            }
          } catch (err) {
            payload = { ok: false, status: out.status, error: 'unexpected primer response shape: ' + String((err && err.message) || err) }
          }
        } else {
          payload = { ok: false, status: out.status, error: describeJinaError(out) }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(payload))
      },
    })
  })

  // ---- web settings namespace ------------------------------------------------
  // The web Settings → Plugins tab is keyed by the settings namespace a card
  // edits and renders a card only for namespaces the Host serves. This
  // registration makes the deployment's settings provider serve "jina-tools",
  // pairing it with the "Jina Tools" card the browser half registers under
  // `key: 'jina-tools'`. The card stores the API key through the credential
  // seam — never the settings document — so the namespace is intentionally
  // empty: no fields to render or store, it exists only to be served.
  //
  // Zero-dependency note: the settings service consumes a schemastery schema
  // as a function (schema(value) → resolved value), serializes it through
  // toJSON(), and walks type/dict/meta for secret redaction. A plain object
  // covering exactly that surface (below) satisfies the runtime contract, so
  // this plugin still imports nothing from the harness's package graph (an
  // out-of-tree bundle at this location cannot resolve those imports).
  // Profiles without a settings provider never mount the inject, and the
  // plugin keeps working exactly as before — just without a served namespace.
  const settingsNamespace = (value) => {
    if (!/^[a-z][a-z0-9-]*$/.test(String(value))) {
      throw new TypeError('settings namespace "' + String(value) + '" must match ^[a-z][a-z0-9-]*$')
    }
    return value
  }

  const EMPTY_SETTINGS_SCHEMA = Object.assign(
    function (value) { return value === undefined || value === null ? {} : value },
    {
      type: 'object',
      dict: {},
      meta: {},
      inner: undefined,
      toJSON() { return { type: 'object' } },
    },
  )

  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(settingsNamespace('jina-tools'), EMPTY_SETTINGS_SCHEMA)
  })
}
