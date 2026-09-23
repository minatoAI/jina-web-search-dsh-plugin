/**
 * Integration tests for the host half's manual-proxy plumbing.
 *
 * The host plugin is driven through a fake Cordis context that mirrors the
 * contracts the real seams expose (`tools.register`, `inject(['webServer'])`,
 * `subprocess.spawn` + `handle.done` + `collected.stdout.readFrom`,
 * `fs.resolve`/`readText`, `sandboxPolicy`).
 *
 * The settings seam is the `Config` export, not a registration call: the
 * harness resolves one raw profile section through `Config['~standard']` and
 * hands the result to `apply` as the second argument, so these tests do the
 * same through `resolveSettings()` — the stored section is `{ proxyUrl }`.
 *
 * What is pinned here — the regression this feature exists for:
 *   A local proxy client that listens on a loopback port WITHOUT being the
 *   Windows system proxy (WinINET `ProxyEnable = 0x0`) is invisible to
 *   automatic discovery. The address saved from the settings card must reach
 *   the spawned network helper as HTTP(S)_PROXY, must outrank discovery and
 *   the inherited environment, and a failure must name the address instead of
 *   reporting a generic network outage.
 *
 * The live case (JINA_LIVE_PROXY=1) spawns the real helper against the real
 * Jina endpoint with a clean proxy environment, so success proves the saved
 * address — not a leftover environment variable — carried the request. It is
 * opt-in (needs a working local proxy) and self-skips where child processes
 * cannot be spawned.
 *
 *   $env:JINA_LIVE_PROXY='1'; $env:JINA_LIVE_PROXY_URL='http://127.0.0.1:7897'; npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { Config, apply } from '../index.js'

/**
 * Resolve one raw stored settings section the way the Loader does before
 * `apply(ctx, config)` — through the plugin's `Config` export.
 */
function resolveSettings(raw) {
  return Config['~standard'].validate(raw === undefined ? {} : raw).value
}

/** Every environment name that can influence proxy selection. */
const ENV_KEYS = [
  'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY', 'JINA_PROXY_URL',
]

/** Proxy transport variables, i.e. everything an inherited base may carry. */
const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']

/** Run `fn` with exactly the given proxy-related environment names set. */
async function withEnv(env, fn) {
  const saved = new Map()
  for (const key of ENV_KEYS) {
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
function fakeHandle(text, stderr = '') {
  return {
    done: Promise.resolve({ exitCode: 0 }),
    collected: {
      stdout: { readFrom: () => ({ text }) },
      stderr: { readFrom: () => ({ text: stderr }) },
    },
  }
}

/**
 * Spawn the helper for real, with a clean proxy environment plus the plan's
 * variables — exactly what the subprocess seam hands a child (the seam merges
 * `env` over its resolved base; here the base is stripped of proxy variables so
 * a green run cannot be explained by an inherited one).
 */
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
  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve({ exitCode: code === null ? -1 : code }))
  })
  return {
    done,
    collected: {
      stdout: { readFrom: () => ({ text: stdout }) },
      stderr: { readFrom: () => ({ text: stderr }) },
    },
  }
}

/** A helper result the transport treats as a failure to reach the network. */
const TRANSPORT_FAILURE = JSON.stringify({ ok: false, status: 0, text: 'fetch failed (proxy unreachable)' })
const OK_DATETIME = JSON.stringify({ ok: true, status: 200, text: '{"data":{"title":"Example","url":"https://example.com"}}' })
const OK_PRIMER = JSON.stringify({ ok: true, status: 200, text: '{"data":{"authenticatedAs":"acct-test","balanceLeft":42}}' })

/** WinINET registry output with the system proxy DISABLED (the user's case). */
const REG_SYSTEM_PROXY_OFF = '    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7897\r\n'
/** WinINET registry output with a system proxy ENABLED. */
const REG_SYSTEM_PROXY_ON = '    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n'

/**
 * Build a fake host context plus the records each assertion needs.
 * @param options - `{ setting, regOutput, helperResults, live }`.
 */
function createHost(options = {}) {
  const execs = []
  const helpers = []
  const routes = new Map()
  const tools = new Map()
  const settingsValue = options.setting === undefined ? {} : { proxyUrl: options.setting }
  const queue = [...(options.helperResults || [])]
  const state = { spawnError: undefined }

  const ctx = {
    get(key) {
      if (key === 'sandboxPolicy') return { workspaceRoot: 'C:\\ws' }
      return undefined
    },
    inject(keys, callback) {
      if (keys.includes('webServer')) {
        callback({ webServer: { register(route) { routes.set(route.path, route) } } })
      }
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
        const record = { argv: spec.argv, env: spec.env, stdin }
        execs.push(record)
        if (spec.argv[1] !== '-e') {
          // WinINET discovery probe.
          return fakeHandle(options.regOutput === undefined ? '' : options.regOutput)
        }
        helpers.push(record)
        if (options.live === true) {
          try {
            return realHandle(spec)
          } catch (err) {
            state.spawnError = err
            return fakeHandle(JSON.stringify({ ok: false, status: 0, text: 'spawn unavailable: ' + String((err && err.message) || err) }))
          }
        }
        const next = queue.length > 0 ? queue.shift() : OK_DATETIME
        return fakeHandle(next)
      },
    },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }

  return { ctx, execs, helpers, routes, tools, settingsValue, state }
}

/** Invoke one registered tool the way the tool seam does. */
function callTool(host, name, args) {
  const tool = host.tools.get(name)
  if (tool === undefined) throw new Error('tool not registered: ' + name)
  return tool.execute(args, { agent: { session: { header: { cwd: 'C:\\ws' } } } })
}

/** Invoke the registered primer route and decode its JSON body. */
async function callPrimerRoute(host) {
  const route = host.routes.get('/api/dsh-jina/primer')
  if (route === undefined) throw new Error('primer route not registered')
  const state = { status: 0, body: '' }
  const res = {
    writeHead(status) { state.status = status },
    end(body) { state.body = body === undefined ? '' : String(body) },
  }
  await route.handler({ method: 'GET' }, res)
  return JSON.parse(state.body)
}

test('the host half declares the jina-tools fields through the Config export', async () => {
  const host = createHost({ setting: 'http://127.0.0.1:7897' })
  apply(host.ctx, resolveSettings(host.settingsValue))
  // The Loader's isSchemastery duck-type probe and the settings provider's
  // `'toJSON' in schema` probe both have to hold, or the namespace is never
  // published and every control on the card stays disabled.
  assert.equal(Config['~standard'].vendor, 'schemastery')
  assert.equal(Config['~standard'].version, 1)
  assert.equal(typeof Config.toJSON, 'function')
  assert.equal(Config.dict.proxyUrl.type, 'string')
  assert.equal(Config.dict.proxyUrl.meta.volatile, true)
  assert.equal(Config.toJSON().dict.proxyUrl.meta.volatile, true, 'toJSON must not strip volatility')
  const resolved = resolveSettings({ proxyUrl: 'http://127.0.0.1:7897' })
  assert.equal(resolved.proxyUrl.get(), 'http://127.0.0.1:7897')
  assert.ok(host.tools.has('jina_web_search'), 'the tool surface still registers')
})

test('a saved manual proxy reaches the spawned helper and skips WinINET discovery', async () => {
  await withEnv({}, async () => {
    const host = createHost({ setting: 'http://127.0.0.1:7897', regOutput: REG_SYSTEM_PROXY_OFF })
    apply(host.ctx, resolveSettings(host.settingsValue))
    await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.equal(host.helpers.length, 1)
    assert.equal(host.execs.length, 1, 'no reg.exe probe while a manual address exists')
    const env = host.helpers[0].env
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7897')
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897')
    assert.equal(env.http_proxy, 'http://127.0.0.1:7897')
    assert.equal(env.https_proxy, 'http://127.0.0.1:7897')
    assert.equal(env.NODE_USE_ENV_PROXY, '1')
    assert.equal('NO_PROXY' in env, false, 'the harness bypass list must survive untouched')
  })
})

test('a bare host:port is normalized before it reaches the helper', async () => {
  await withEnv({}, async () => {
    const host = createHost({ setting: '127.0.0.1:7897' })
    apply(host.ctx, resolveSettings(host.settingsValue))
    await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.equal(host.helpers[0].env.HTTPS_PROXY, 'http://127.0.0.1:7897')
  })
})

test('the manual address outranks WinINET discovery, JINA_PROXY_URL and the inherited environment', async () => {
  await withEnv({ JINA_PROXY_URL: 'http://127.0.0.1:1080', HTTPS_PROXY: 'http://127.0.0.1:3128' }, async () => {
    const host = createHost({ setting: 'http://127.0.0.1:7897', regOutput: REG_SYSTEM_PROXY_ON })
    apply(host.ctx, resolveSettings(host.settingsValue))
    await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.equal(host.helpers[0].env.HTTPS_PROXY, 'http://127.0.0.1:7897')
    assert.equal(host.execs.length, 1, 'discovery is not even consulted')
  })
})

test('JINA_PROXY_URL covers profiles without a settings provider', async () => {
  await withEnv({ JINA_PROXY_URL: 'http://127.0.0.1:1080' }, async () => {
    const host = createHost({ regOutput: REG_SYSTEM_PROXY_ON })
    apply(host.ctx, resolveSettings(host.settingsValue))
    await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.equal(host.helpers[0].env.HTTPS_PROXY, 'http://127.0.0.1:1080')
  })
})

test('without a manual address the WinINET system proxy still wins (0.5.3 behavior preserved)', async () => {
  await withEnv({ HTTPS_PROXY: 'http://127.0.0.1:3128' }, async () => {
    const host = createHost({ regOutput: REG_SYSTEM_PROXY_ON })
    apply(host.ctx, resolveSettings(host.settingsValue))
    await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.equal(host.helpers[0].env.HTTPS_PROXY, 'http://127.0.0.1:7890')
    assert.equal(host.execs.length, 2, 'reg.exe was probed')
  })
})

test('with no proxy configured anywhere the helper inherits the harness environment untouched', async () => {
  await withEnv({}, async () => {
    const host = createHost({ regOutput: REG_SYSTEM_PROXY_OFF })
    apply(host.ctx, resolveSettings(host.settingsValue))
    await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.equal(host.helpers[0].env, undefined, 'undefined env = the seam keeps its resolved base')
  })
})

test('a transport failure names the manually configured proxy', async () => {
  await withEnv({}, async () => {
    const host = createHost({ setting: 'http://127.0.0.1:7999', helperResults: [TRANSPORT_FAILURE, TRANSPORT_FAILURE] })
    apply(host.ctx, resolveSettings(host.settingsValue))
    const text = await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.match(text, /http:\/\/127\.0\.0\.1:7999/)
    assert.match(text, /本地代理/)
    assert.match(text, /清除/)
  })
})

test('an unusable saved address is reported and falls back to automatic detection', async () => {
  await withEnv({}, async () => {
    const host = createHost({
      setting: 'socks5://127.0.0.1:7897',
      regOutput: REG_SYSTEM_PROXY_OFF,
      helperResults: [TRANSPORT_FAILURE, TRANSPORT_FAILURE],
    })
    apply(host.ctx, resolveSettings(host.settingsValue))
    const text = await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.match(text, /socks5:\/\/127\.0\.0\.1:7897/)
    assert.match(text, /已回退到自动检测/)
    assert.match(text, /http:\/\/127\.0\.0\.1:7897|未检测到可用代理/)
  })
})

test('the primer route reports the proxy actually in play and what the card stored', async () => {
  await withEnv({}, async () => {
    const host = createHost({ setting: 'http://127.0.0.1:7897', helperResults: [OK_PRIMER] })
    apply(host.ctx, resolveSettings(host.settingsValue))
    const payload = await callPrimerRoute(host)
    assert.equal(payload.ok, true)
    assert.equal(payload.proxyConfigured, 'http://127.0.0.1:7897')
    assert.equal(payload.settingsLive, true, 'the card health check reports the settings seam is live')
    assert.equal(payload.proxy.source, 'setting')
    assert.equal(payload.proxy.url, 'http://127.0.0.1:7897')
    assert.equal(payload.authenticatedAs, 'acct-test')
    assert.equal(payload.balanceLeft, 42)
  })
})

test('the primer route reports the automatic source when nothing is saved', async () => {
  await withEnv({}, async () => {
    const host = createHost({ regOutput: REG_SYSTEM_PROXY_ON, helperResults: [OK_PRIMER] })
    apply(host.ctx, resolveSettings(host.settingsValue))
    const payload = await callPrimerRoute(host)
    assert.equal(payload.proxyConfigured, '')
    assert.equal(payload.settingsLive, true, 'a stored section with no proxyUrl still resolves to live refs')
    assert.equal(payload.proxy.source, 'system')
    assert.equal(payload.proxy.url, 'http://127.0.0.1:7890')
  })
})

test('the primer route stays honest when the probe fails', async () => {
  await withEnv({}, async () => {
    const host = createHost({ setting: 'http://127.0.0.1:7999', helperResults: [TRANSPORT_FAILURE, TRANSPORT_FAILURE] })
    apply(host.ctx, resolveSettings(host.settingsValue))
    const payload = await callPrimerRoute(host)
    assert.equal(payload.ok, false)
    assert.equal(payload.proxy.source, 'setting')
    assert.match(payload.error, /7999/)
  })
})

// ---- live settings writes --------------------------------------------------
// The regression the volatile schema exists for: saving on the card must reach
// the next operation without a restart. The settings provider writes a saved
// field into the volatile reference the resolved config holds (the object
// `apply` captured keeps its identity), so the plugin re-reads it per call.

test('a proxy address saved on the card reaches the next call without a restart', async () => {
  await withEnv({}, async () => {
    const host = createHost({ regOutput: REG_SYSTEM_PROXY_OFF })
    // Only the `reg.exe` probes: the helper spawn is not a discovery probe.
    const probes = () => host.execs.filter((e) => e.argv[1] !== '-e').length
    const config = resolveSettings(host.settingsValue)
    apply(host.ctx, config)
    await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.equal(probes(), 1, 'nothing saved yet, so WinINET is probed')
    assert.equal(host.helpers[0].env, undefined, 'and no proxy is layered on')

    config.proxyUrl[Symbol.for('cosmokit.volatile.write')]('http://127.0.0.1:7897')

    await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.equal(host.helpers[1].env.HTTPS_PROXY, 'http://127.0.0.1:7897', 'the saved address must apply to the next call')
    assert.equal(probes(), 1, 'and it is used without another discovery probe')

    config.proxyUrl[Symbol.for('cosmokit.volatile.write')]('')
    await callTool(host, 'jina_datetime', { url: 'https://example.com' })
    assert.equal(host.helpers[2].env, undefined, 'clearing the card falls back to automatic detection')
    assert.equal(probes(), 1, 'the discovery result is cached for a minute')
  })
})

// ---- live case -------------------------------------------------------------
// Opt-in: needs a working local proxy. The helper is spawned for real with a
// CLEAN proxy environment plus the plan's variables, so a green run proves the
// saved address — not an inherited HTTP_PROXY — carried the request. Skips
// itself where child processes cannot be spawned (a sandboxed runner).
const live = process.env.JINA_LIVE_PROXY === '1'
const liveProxy = process.env.JINA_LIVE_PROXY_URL || 'http://127.0.0.1:7897'

test('live: the configured local proxy carries a real Jina request', { skip: live ? false : 'set JINA_LIVE_PROXY=1 to run' }, async (t) => {
  await withEnv({}, async () => {
    const host = createHost({ setting: liveProxy, live: true, regOutput: REG_SYSTEM_PROXY_OFF })
    apply(host.ctx, resolveSettings(host.settingsValue))
    const text = await callTool(host, 'jina_datetime', { url: 'https://example.com', json: true })
    if (host.state.spawnError !== undefined) {
      t.skip('child processes cannot be spawned here: ' + String((host.state.spawnError && host.state.spawnError.message) || host.state.spawnError))
      return
    }
    let d
    try {
      const data = JSON.parse(text)
      d = data && typeof data === 'object' && data.data && typeof data.data === 'object' ? data.data : data
    } catch (err) {
      d = undefined
    }
    assert.ok(
      d && (d.title || d.url),
      'expected a real Jina payload carried by ' + liveProxy + ', got: ' + text.slice(0, 400),
    )
  })
})
