/**
 * Integration tests for the host half's endpoint routing.
 *
 * The host plugin is driven through a fake Cordis context that mirrors the
 * contracts the real seams expose (`tools.register`, `inject(['webServer'])`,
 * `subprocess.spawn` + `handle.done` + `collected.stdout.readFrom`,
 * `fs.resolve`/`readText`, `sandboxPolicy`, `credentials.resolve`). Every helper
 * spawn is recorded with its argv, its `env` overlay and its decoded stdin, so
 * the tests assert the exact URL each attempt hit and the environment it ran in.
 *
 * What is pinned here — the regression this feature exists for:
 *   Jina's global hosts (`r.jina.ai`, `s.jina.ai`) are DNS-poisoned and their
 *   origins blackholed from mainland China, so a call from there dies at connect
 *   time. The vendor publishes official mainland mirrors (`r.jinaai.cn`,
 *   `s.jinaai.cn`) that answer the same API. The plugin therefore needs no proxy
 *   at all — but it must (a) never repeat a host that just failed, (b) put a
 *   transport failure on the other side instead of retrying the same one for
 *   another full timeout, (c) keep a CN request off any inherited proxy, and
 *   (d) respect a pinned mode rather than silently falling back.
 *
 * The live case (JINA_LIVE_CN=1) spawns the real helper against the real CN
 * endpoint, so a green run proves the route itself — not a fixture — carries a
 * request. It is opt-in and self-skips where child processes cannot be spawned.
 *
 *   $env:JINA_LIVE_CN='1'; npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { Config, apply } from '../index.js'

/**
 * Resolve one raw stored settings section the way the Loader does before
 * `apply(ctx, config)`.
 */
function resolveSettings(raw) {
  return Config['~standard'].validate(raw === undefined ? {} : raw).value
}

/** Every environment name a CN attempt must not be captured by. */
const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY', 'NO_PROXY', 'no_proxy']

/** Run `fn` with exactly the given proxy-related environment names set. */
async function withEnv(env, fn) {
  const saved = new Map()
  for (const key of PROXY_VARS) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined)
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  try {
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** A subprocess handle shaped like the seam's: `done` + `collected.*.readFrom`. */
function fakeHandle(text) {
  return {
    done: Promise.resolve({ exitCode: 0 }),
    collected: {
      stdout: { readFrom: () => ({ text }) },
      stderr: { readFrom: () => ({ text: '' }) },
    },
  }
}

/** Spawn the helper for real, exactly as the seam would. */
function realHandle(spec) {
  const base = { ...process.env }
  for (const key of PROXY_VARS) delete base[key]
  const env = spec.env === undefined ? base : { ...base, ...spec.env }
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const stdinData = spec.stdio && spec.stdio.stdin && typeof spec.stdio.stdin === 'object'
    ? spec.stdio.stdin.data
    : undefined
  child.stdin.end(stdinData === undefined ? '' : stdinData)
  return {
    done: new Promise((resolve) => { child.on('close', (code) => resolve({ exitCode: code === null ? -1 : code })) }),
    collected: {
      stdout: { readFrom: () => ({ text: stdout }) },
      stderr: { readFrom: () => ({ text: stderr }) },
    },
  }
}

/** A helper result the transport treats as a failure to reach the host. */
const TRANSPORT_FAILURE = JSON.stringify({ ok: false, status: 0, text: 'fetch failed' })
/** A successful `jina_datetime` answer (one request, no key, no retry logic). */
const OK_DATETIME = JSON.stringify({ ok: true, status: 200, text: '{"data":{"title":"Example","url":"https://example.com"}}' })

/**
 * Build a fake host context plus the records each assertion needs.
 * @param options - `{ settings, results, live, nodePath, key }`.
 */
function createHost(options = {}) {
  const helpers = []
  const tools = new Map()
  const routes = new Map()
  const queue = [...(options.results || [])]
  const settingsValue = options.settings === undefined ? {} : options.settings
  const key = options.key === undefined ? 'k-test' : options.key

  const ctx = {
    get(name) {
      if (name === 'sandboxPolicy') return { workspaceRoot: process.cwd() }
      if (name === 'credentials') {
        return {
          async resolve(ref) { return ref === 'JINA_API_KEY' ? { value: key, source: 'file' } : undefined },
          async unset() { return undefined },
        }
      }
      return undefined
    },
    inject(keys, callback) {
      if (keys.includes('webServer')) callback({ webServer: { register(route) { routes.set(route.path, route) } } })
    },
    fs: {
      async resolve(path) { throw new Error('ENOENT ' + path) },
      async readText() { throw new Error('ENOENT') },
    },
    subprocess: {
      async resolveExecutable() { return options.nodePath || process.execPath },
      spawn(spec) {
        const stdin = spec.stdio && spec.stdio.stdin && typeof spec.stdio.stdin === 'object'
          ? spec.stdio.stdin.data
          : undefined
        if (spec.argv[1] !== '-e') return fakeHandle('')
        const request = JSON.parse(stdin)
        helpers.push({ url: request.url, env: spec.env, request, spec })
        if (options.live === true) return realHandle(spec)
        return fakeHandle(queue.length > 0 ? queue.shift() : OK_DATETIME)
      },
    },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }
  return { ctx, helpers, tools, routes, settingsValue }
}

/** Invoke one registered tool the way the tool seam does. */
function callTool(host, name, args) {
  const tool = host.tools.get(name)
  assert.ok(tool !== undefined, name + ' must be registered')
  return tool.execute(args, { agent: { session: { header: { cwd: process.cwd() } } } })
}

/** Invoke the registered primer route and decode its JSON body. */
async function callPrimerRoute(host) {
  const route = host.routes.get('/api/dsh-jina/primer')
  assert.ok(route !== undefined, 'the primer route must be registered')
  const state = { status: 0, body: '' }
  await route.handler({ method: 'GET' }, {
    writeHead(status) { state.status = status },
    end(body) { state.body = body === undefined ? '' : String(body) },
  })
  return JSON.parse(state.body)
}

/** Mount the plugin over a fresh host and return it. */
function mount(options) {
  const host = createHost(options)
  apply(host.ctx, resolveSettings(host.settingsValue))
  return host
}

test('the host half declares the endpoint field through the Config export', async () => {
  assert.equal(Config['~standard'].vendor, 'schemastery')
  assert.equal(Config['~standard'].version, 1)
  assert.equal(Config.dict.endpoint.type, 'string')
  assert.equal(Config.dict.endpoint.meta.volatile, true)
  assert.equal(Config.toJSON().dict.endpoint.meta.volatile, true, 'toJSON must not strip volatility')
  const resolved = resolveSettings({ endpoint: 'cn' })
  assert.equal(resolved.endpoint.get(), 'cn')
  const host = mount({})
  assert.ok(host.tools.has('jina_read'), 'the tool surface still registers')
  assert.ok(host.tools.has('jina_web_search'), 'the search surface still registers')
})

test('with no config the call goes to the global host and inherits the environment untouched', async () => {
  await withEnv({ HTTPS_PROXY: 'http://127.0.0.1:3128' }, async () => {
    const host = mount({})
    await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.equal(host.helpers.length, 1)
    assert.equal(host.helpers[0].url, 'https://r.jina.ai/')
    // `undefined` env = the seam keeps its resolved base; the plugin configures
    // no proxy of its own.
    assert.equal(host.helpers[0].env, undefined)
  })
})

test('auto: a transport failure moves to the mainland mirror and adds its NO_PROXY suffix', async () => {
  await withEnv({ NO_PROXY: 'localhost,127.0.0.1' }, async () => {
    const host = mount({ results: [TRANSPORT_FAILURE] })
    await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.equal(host.helpers.length, 2, 'exactly one attempt per side')
    assert.equal(host.helpers[0].url, 'https://r.jina.ai/')
    assert.equal(host.helpers[1].url, 'https://r.jinaai.cn/')
    assert.equal(host.helpers[1].env.NO_PROXY, 'localhost,127.0.0.1,jinaai.cn', 'the inherited list survives, the suffix is appended')
    assert.equal(host.helpers[1].env.no_proxy, host.helpers[1].env.NO_PROXY)
    assert.equal('HTTP_PROXY' in host.helpers[1].env, false, 'the plugin never writes a proxy variable')
  })
})

test('auto: the side that answered is remembered for the rest of the process', async () => {
  const host = mount({ results: [TRANSPORT_FAILURE] })
  await callTool(host, 'jina_datetime', { url: 'https://example.com' })
  assert.deepEqual(host.helpers.map((h) => h.url), ['https://r.jina.ai/', 'https://r.jinaai.cn/'])
  await callTool(host, 'jina_datetime', { url: 'https://example.com' })
  assert.deepEqual(host.helpers.map((h) => h.url), ['https://r.jina.ai/', 'https://r.jinaai.cn/', 'https://r.jinaai.cn/'],
    'the second call must not pay for the dead side again')
})

test('auto: an answer that is not a transport failure pins that side too', async () => {
  const host = mount({ results: [JSON.stringify({ ok: false, status: 503, text: 'maintenance' })] })
  await callTool(host, 'jina_datetime', { url: 'https://example.com' })
  // A 503 proves the host answered: the route works, the server does not.
  assert.equal(host.helpers.length, 1)
  assert.equal(host.helpers[0].url, 'https://r.jina.ai/')
  await callTool(host, 'jina_datetime', { url: 'https://example.com' })
  assert.equal(host.helpers[1].url, 'https://r.jina.ai/', 'still the global side')
})

test('a pinned CN mode never falls back and always bypasses an inherited proxy', async () => {
  await withEnv({ HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost' }, async () => {
    const host = mount({ settings: { endpoint: 'cn' }, results: [TRANSPORT_FAILURE, TRANSPORT_FAILURE] })
    const out = await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.equal(host.helpers.length, 1, 'a pinned mode is one candidate, not a hint')
    assert.equal(host.helpers[0].url, 'https://r.jinaai.cn/')
    assert.equal(host.helpers[0].env.NO_PROXY, 'localhost,jinaai.cn')
    assert.match(out, /已尝试的接口域名：https:\/\/r\.jinaai\.cn\//)
    assert.match(out, /固定为国内域名/)
  })
})

test('a pinned global mode never falls back either', async () => {
  const host = mount({ settings: { endpoint: 'global' }, results: [TRANSPORT_FAILURE, TRANSPORT_FAILURE] })
  const out = await callTool(host, 'jina_datetime', { url: 'https://example.com' })
  assert.equal(host.helpers.length, 1)
  assert.equal(host.helpers[0].url, 'https://r.jina.ai/')
  assert.match(out, /No response from any Jina endpoint/)
  assert.match(out, /已尝试的接口域名：https:\/\/r\.jina\.ai\/。/)
})

test('a transport failure reports both hosts and never repeats one', async () => {
  const host = mount({ results: [TRANSPORT_FAILURE, TRANSPORT_FAILURE] })
  const out = await callTool(host, 'jina_datetime', { url: 'https://example.com' })
  assert.equal(host.helpers.length, 2)
  assert.equal(new Set(host.helpers.map((h) => h.url)).size, 2)
  assert.match(out, /已尝试的接口域名：https:\/\/r\.jina\.ai\/、https:\/\/r\.jinaai\.cn\//)
})

test('the search tools use the search host pair, not the reader one', async () => {
  const host = mount({ results: [JSON.stringify({ ok: true, status: 200, text: '{"code":200,"status":20000,"data":[{"title":"Reader API","url":"https://jina.ai/reader/","description":"d"}]}' })] })
  const out = await callTool(host, 'jina_web_search', { query: 'jina reader' })
  assert.equal(host.helpers.length, 1)
  assert.equal(host.helpers[0].url, 'https://s.jina.ai/')
  assert.match(out, /Reader API/)
  assert.match(out, /jina\.ai\/reader\//)
})

test('the academic shortcuts restrict the search with the `site` field the endpoint honours', async () => {
  const host = mount({ results: [JSON.stringify({ ok: true, status: 200, text: '{"code":200,"status":20000,"data":[]}' })] })
  await callTool(host, 'jina_search_arxiv', { query: 'graph neural networks' })
  const arxiv = JSON.parse(host.helpers[0].request.body)
  assert.equal(arxiv.site, 'arxiv.org')
  assert.equal(arxiv.domain, undefined, '`domain` is ignored by s.jina.ai — it must not be sent')
  await callTool(host, 'jina_search_ssrn', { query: 'audit quality' })
  const ssrn = JSON.parse(host.helpers[1].request.body)
  assert.equal(ssrn.site, 'ssrn.com')
})

test('a saved endpoint reaches the next call without a restart', async () => {
  const host = createHost({})
  const config = resolveSettings(host.settingsValue)
  apply(host.ctx, config)
  await callTool(host, 'jina_datetime', { url: 'https://example.com' })
  assert.equal(host.helpers[0].url, 'https://r.jina.ai/')
  config.endpoint[Symbol.for('cosmokit.volatile.write')]('cn')
  await callTool(host, 'jina_datetime', { url: 'https://example.com' })
  assert.equal(host.helpers[1].url, 'https://r.jinaai.cn/', 'the saved mode must apply to the next call')
  assert.equal(host.helpers[1].env.NO_PROXY, 'jinaai.cn')
})

test('the primer route reports the endpoint side that answered', async () => {
  const host = mount({ settings: { endpoint: 'cn' }, results: [JSON.stringify({ ok: true, status: 200, text: '{"data":{"authenticatedAs":"acct","balanceLeft":42}}' })] })
  const payload = await callPrimerRoute(host)
  assert.equal(payload.ok, true)
  assert.equal(payload.endpoint.mode, 'cn')
  assert.equal(payload.endpoint.side, 'cn')
  assert.equal(payload.endpoint.base, 'https://r.jinaai.cn/')
  assert.equal(payload.settingsLive, true)
})

test('the primer route reports the side a fallback landed on', async () => {
  const host = mount({
    results: [
      TRANSPORT_FAILURE,
      JSON.stringify({ ok: true, status: 200, text: '{"data":{"authenticatedAs":"acct","balanceLeft":42}}' }),
    ],
  })
  const payload = await callPrimerRoute(host)
  assert.equal(payload.ok, true)
  assert.equal(payload.endpoint.mode, 'auto')
  assert.equal(payload.endpoint.side, 'cn')
  assert.equal(payload.endpoint.base, 'https://r.jinaai.cn/')
})

test('the primer route stays honest when both sides fail', async () => {
  const host = mount({ results: [TRANSPORT_FAILURE, TRANSPORT_FAILURE] })
  const payload = await callPrimerRoute(host)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /No response from any Jina endpoint/)
  assert.match(payload.error, /已尝试的接口域名/)
  assert.equal(payload.endpoint.side, null)
})

// Opt-in: needs the real network (and, from mainland China, nothing else — that
// is the point of the CN route). The helper is spawned for real with the CN
// environment, so a green run proves the route carries a live request.
const live = process.env.JINA_LIVE_CN === '1'

test('live: the CN route carries a real Jina request', { skip: live ? false : 'set JINA_LIVE_CN=1 to run' }, async () => {
  // An empty pool: `jina_datetime` is anonymous-capable, and a fake key would
  // only prove the endpoint rejects it.
  const host = mount({ settings: { endpoint: 'cn' }, live: true, key: '' })
  const text = await callTool(host, 'jina_datetime', { url: 'https://example.com' })
  assert.equal(host.helpers.length, 1, 'the pinned CN route is one attempt')
  assert.equal(host.helpers[0].url, 'https://r.jinaai.cn/')
  assert.doesNotMatch(text, /Jina API error|timeout after/, 'expected a live answer, got: ' + text.slice(0, 300))
})
