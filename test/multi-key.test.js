/**
 * Integration tests for the multi-key pool and its automatic failover.
 *
 * The host plugin is driven through a fake Cordis context that mirrors the
 * contracts the real seams expose (`tools.register`, `inject(['webServer'])`,
 * `subprocess.spawn` + `handle.done` + `collected.stdout.readFrom`,
 * `fs.resolve`/`readText`, `sandboxPolicy`, and `credentials.resolve`). The
 * helper's stdin is decoded for every request, so the tests assert the exact
 * `Authorization` header each key was tried with.
 *
 * What is pinned here — the regression this feature exists for:
 *   A Jina account whose credits run out answers HTTP 402, and before this
 *   feature that ended the operation: the task was interrupted mid-flight and
 *   the user had to notice, top up and start over. With a pool, a 402 (or 429,
 *   or a revoked 401) parks that key and the next saved key serves the call, so
 *   the operation completes and the switch is reported.
 *
 * The rotation policy itself is unit-tested in test/keys.test.js; this file
 * tests the wiring: source precedence, deduplication, the round-robin cursor,
 * cooldowns, the explicit-key escape hatch, and the per-key health the card's
 * `/api/dsh-jina/primer` route reports.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, apply } from '../index.js'
import { KEY_FILE, KEY_REFS } from '../keys.js'

/** Resolve one raw stored settings section the way the Loader does before apply(). */
function resolveSettings(raw) {
  return Config['~standard'].validate(raw === undefined ? {} : raw).value
}

/** One HTTP reply envelope, exactly as the network helper writes it. */
function envelope(status, text) {
  return JSON.stringify({ ok: status >= 200 && status < 300, status, text })
}

/** One successful search payload, long enough to survive the formatter. */
function searchOk() {
  return envelope(200, JSON.stringify({ results: [{ title: 'Wake word detection', url: 'https://example.com/kws', snippet: 'snippet' }] }))
}

function fakeHandle(text) {
  return {
    done: Promise.resolve({ exitCode: 0 }),
    collected: {
      stdout: { readFrom: () => ({ text }) },
      stderr: { readFrom: () => ({ text: '' }) },
    },
  }
}

/** The key a helper request was authenticated with ('' when anonymous). */
function keyOf(request) {
  return String((request.headers && request.headers.Authorization) || '').replace(/^Bearer /, '')
}

/**
 * A helper reply keyed by the key that made the request.
 * @param statuses - `{ <key>: httpStatus }`; anything unlisted answers 200.
 * @param payload - the body of a 200 answer.
 */
function perKey(statuses, payload) {
  return (request) => {
    const status = statuses[keyOf(request)]
    if (status === undefined || (status >= 200 && status < 300)) {
      return envelope(200, JSON.stringify(payload === undefined ? { results: [{ title: 'hit', url: 'https://example.com' }] } : payload))
    }
    return envelope(status, 'server said ' + status)
  }
}

/**
 * Build a fake host context plus the records each assertion needs.
 * @param options - `{ keys, file, source, reply, probe, unsetFails }`.
 */
function createHost(options = {}) {
  const requests = []
  const tools = new Map()
  const routes = new Map()
  const fsCalls = []
  const unsets = []
  const credentials = options.keys === undefined ? {} : options.keys
  const reply = options.reply
  const ctx = {
    get(key) {
      if (key === 'sandboxPolicy') return { workspaceRoot: 'C:\\ws' }
      if (key === 'credentials') {
        return {
          async resolve(ref) {
            const value = credentials[ref]
            if (value === undefined) return undefined
            return { value: value, source: options.source || 'file' }
          },
          async unset(ref) {
            unsets.push(ref)
            if (options.unsetFails === true) {
              // What the seam does for a reference the launching environment
              // supplies read-only.
              throw new Error('credentials-local: "' + ref + '" is supplied read-only by the launching environment')
            }
            delete credentials[ref]
          },
        }
      }
      return undefined
    },
    inject(keys, callback) {
      if (keys.includes('webServer')) {
        callback({ webServer: { register(route) { routes.set(route.path, route) } } })
      }
    },
    fs: {
      async resolve(path) {
        fsCalls.push(path)
        if (options.file === undefined) throw new Error('ENOENT ' + path)
        return path
      },
      async readText() {
        if (options.file === undefined) throw new Error('ENOENT')
        return options.file
      },
    },
    subprocess: {
      async resolveExecutable() { return process.execPath },
      spawn(spec) {
        // The WinINET discovery probe is the only spawn without `-e`.
        if (spec.argv[1] !== '-e') return fakeHandle('')
        const stdin = spec.stdio && spec.stdio.stdin && typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined
        const request = JSON.parse(stdin)
        requests.push(request)
        return fakeHandle(typeof reply === 'function' ? reply(request, requests.length) : reply)
      },
    },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }
  return { ctx, requests, tools, routes, fsCalls, credentials, unsets }
}

/** Invoke one registered tool the way the tool seam does. */
function callTool(host, name, args) {
  const tool = host.tools.get(name)
  assert.ok(tool !== undefined, name + ' must be registered')
  return tool.execute(args, { agent: { session: { header: { cwd: 'C:\\ws' } } } })
}

/** Invoke the primer route and decode its JSON body. */
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

/** Invoke the balance route and decode its JSON body. */
async function callBalanceRoute(host) {
  const route = host.routes.get('/api/dsh-jina/balance')
  assert.ok(route !== undefined, 'the balance route must be registered')
  const state = { status: 0, body: '' }
  await route.handler({ method: 'GET' }, {
    writeHead(status) { state.status = status },
    end(body) { state.body = body === undefined ? '' : String(body) },
  })
  return JSON.parse(state.body)
}

/** A Reader-root probe is the only GET the plugin makes; a tool call is a POST. */
function isProbe(request) {
  return request.method === 'GET'
}

/** Every probe made so far, as the key it authenticated. */
function probesOf(host) {
  return host.requests.filter(isProbe).map(keyOf)
}

/** Let the probe round's promise chain finish under a mocked clock. */
async function settleAsync() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Mount the plugin over a fresh host. */
function mount(options) {
  const host = createHost(options)
  apply(host.ctx, resolveSettings({}))
  return host
}

// ---- the failover ----------------------------------------------------------

test('a quota-exhausted key hands the call to the next saved key', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: perKey({ k1: 402, k2: 200 }),
  })
  const out = await callTool(host, 'jina_web_search', { query: 'wake word detection' })
  assert.equal(host.requests.length, 2, 'exactly one request per tried key')
  assert.equal(keyOf(host.requests[0]), 'k1')
  assert.equal(keyOf(host.requests[1]), 'k2')
  assert.match(out, /example\.com/, 'the call still returns its result')
  assert.match(out, /已自动切换 API key/)
  assert.match(out, /额度耗尽（HTTP 402）/)
  assert.match(out, /JINA_API_KEY_2/, 'the note names the slot that took over')
})

// ---- automatic discard ------------------------------------------------------
// The user never manages the pool: a key that cannot serve a call is deleted
// from the credential store, so the counts on the card keep themselves honest.

test('an overdrawn key is discarded from the credential store, not parked', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: perKey({ k1: 402, k2: 200 }),
  })
  const out = await callTool(host, 'jina_web_search', { query: 'q' })
  assert.deepEqual(host.unsets, ['JINA_API_KEY'], 'the 402 key is deleted')
  assert.equal(host.credentials.JINA_API_KEY, undefined, 'and gone from the store')
  assert.equal(host.credentials.JINA_API_KEY_2, 'k2', 'the working key stays')
  assert.match(out, /已自动移除/, 'the note says the key was removed')

  // The next call must not even try it: it is no longer in the pool.
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(host.requests.length, 3)
  assert.equal(keyOf(host.requests[2]), 'k2')
  assert.equal(host.unsets.length, 1, 'nothing is deleted twice')
})

test('a revoked key is discarded too, and the whole-pool error says so', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: envelope(401, 'revoked'),
  })
  const err = await callTool(host, 'jina_web_search', { query: 'q' }).then(
    () => assert.fail('401 must throw'),
    (e) => e,
  )
  assert.deepEqual(host.unsets, ['JINA_API_KEY', 'JINA_API_KEY_2'])
  assert.equal(host.credentials.JINA_API_KEY, undefined)
  assert.equal(host.credentials.JINA_API_KEY_2, undefined)
  assert.match(err.message, /已依次尝试 2 个 key/)
  assert.match(err.message, /已自动移除/)
})

test('a rate-limited key is parked, never discarded', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: perKey({ k1: 429, k2: 200 }),
  })
  const out = await callTool(host, 'jina_web_search', { query: 'q' })
  assert.match(out, /限流（HTTP 429）/)
  assert.deepEqual(host.unsets, [], 'a temporary rate limit must not delete a working key')
  assert.equal(host.credentials.JINA_API_KEY, 'k1', 'the key stays stored')
  assert.doesNotMatch(out, /已自动移除/)
})

test('a key the launching environment supplies read-only stays in place', async () => {
  // The seam refuses to unset a reference an environment variable shadows, so
  // the discard cannot happen — the cooldown machinery has to carry it instead.
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    unsetFails: true,
    reply: perKey({ k1: 402, k2: 200 }),
  })
  const out = await callTool(host, 'jina_web_search', { query: 'q' })
  assert.match(out, /已自动切换 API key/)
  assert.deepEqual(host.unsets, ['JINA_API_KEY'], 'the attempt was made')
  assert.equal(host.credentials.JINA_API_KEY, 'k1', 'but the read-only value survives')
  assert.doesNotMatch(out, /已自动移除/, 'a failed delete must not be claimed as one')
})

test('a key that came from a file is skipped, never deleted', async () => {
  const host = mount({
    keys: {},
    file: 'f1\nf2\n',
    reply: perKey({ f1: 402, f2: 200 }),
  })
  const out = await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(host.requests.length, 2)
  assert.deepEqual(host.unsets, [], 'the plugin never rewrites a user file or its refs')
  assert.doesNotMatch(out, /已自动移除/)
})

test('round-robin: consecutive calls use different keys', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: perKey({ k1: 200, k2: 200 }),
  })
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(keyOf(host.requests[0]), 'k1', 'the first call starts at slot #1')
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(keyOf(host.requests[1]), 'k2', 'the next call rotates on instead of pinning k1')
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(keyOf(host.requests[2]), 'k1', 'and wraps around')
})

test('a parked key is skipped while a healthy one remains', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: perKey({ k1: 402, k2: 200 }),
  })
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(host.requests.length, 2)

  const out = await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(host.requests.length, 3, 'the parked key costs no request')
  assert.equal(keyOf(host.requests[2]), 'k2', 'the exhausted key is inside its cooldown')
  assert.doesNotMatch(out, /已自动切换/, 'no switch happened in this call, so no note')
})

test('the pool is walked until a key answers: 402 then 429 then success', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2', JINA_API_KEY_3: 'k3' },
    reply: perKey({ k1: 402, k2: 429, k3: 200 }),
  })
  const out = await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(host.requests.length, 3)
  assert.deepEqual(host.requests.map(keyOf), ['k1', 'k2', 'k3'])
  assert.match(out, /额度耗尽（HTTP 402）/)
  assert.match(out, /限流（HTTP 429）/)
})

test('a non-key failure stops the rotation instead of burning the pool', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: envelope(422, '{"detail":"Invalid request parameters"}'),
  })
  const err = await callTool(host, 'jina_web_search', { query: 'q' }).then(
    () => assert.fail('422 must throw'),
    (e) => e,
  )
  assert.match(err.message, /HTTP 422/)
  assert.equal(host.requests.length, 1, 'rotating cannot fix the caller\'s arguments')
})

test('an upstream 5xx is returned as-is without rotating', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: envelope(503, 'maintenance'),
  })
  const out = await callTool(host, 'jina_web_search', { query: 'q' })
  assert.match(out, /server error \(HTTP 503\)/)
  assert.equal(host.requests.length, 1)
})

test('a transport failure moves to the other endpoint side, not another key', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: envelope(0, 'fetch failed'),
  })
  const out = await callTool(host, 'jina_web_search', { query: 'q' })
  // `auto` (the default) tries Jina's global host first, then the vendor's
  // mainland mirror; both attempts use the key the walk chose, because status 0
  // says nothing about the key. A transport failure is a routing fact, so it
  // never rotates the pool and never repeats the same host.
  assert.equal(host.requests.length, 2)
  assert.deepEqual(host.requests.map(keyOf), ['k1', 'k1'])
  assert.deepEqual(host.requests.map((r) => r.url), ['https://s.jina.ai/', 'https://s.jinaai.cn/'])
  assert.match(out, /No response from any Jina endpoint/)
  assert.match(out, /已尝试的接口域名：https:\/\/s\.jina\.ai\/、https:\/\/s\.jinaai\.cn\//)
  assert.doesNotMatch(out, /已自动切换/)
})

test('an explicit apiKey is used alone: it is the caller\'s own choice', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: perKey({ own: 402 }),
  })
  const out = await callTool(host, 'jina_web_search', { query: 'q', apiKey: 'own' })
  assert.equal(host.requests.length, 1, 'there is nothing to rotate to')
  assert.equal(keyOf(host.requests[0]), 'own')
  assert.match(out, /HTTP 402/)
})

test('a fully exhausted pool reports every key it tried', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: envelope(402, 'quota'),
  })
  const out = await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(host.requests.length, 2)
  assert.match(out, /已依次尝试 2 个 key/)
  assert.match(out, /#1（凭据 JINA_API_KEY）额度耗尽（HTTP 402）/)
  assert.match(out, /#2（凭据 JINA_API_KEY_2）额度耗尽（HTTP 402）/)
  assert.match(out, /所有已保存的 key 都已尝试/)
  assert.match(out, /jina\.ai\/api-dashboard\/billing/)
})

test('a fully revoked pool throws with the same per-key account', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: envelope(401, 'Authentication is required'),
  })
  const err = await callTool(host, 'jina_web_search', { query: 'q' }).then(
    () => assert.fail('401 must throw'),
    (e) => e,
  )
  assert.equal(host.requests.length, 2)
  assert.match(err.message, /HTTP 401/)
  assert.match(err.message, /已依次尝试 2 个 key/)
  assert.match(err.message, /无效（HTTP 401）/)
})

test('a 401 on the whole pool re-reads the sources once, then reports', async () => {
  // The fix may have landed mid-call (the old 401 re-read). Here nothing
  // changed, so the second pass finds the same values and does not repeat them.
  const host = mount({
    keys: { JINA_API_KEY: 'k1' },
    reply: envelope(401, 'revoked'),
  })
  await callTool(host, 'jina_web_search', { query: 'q' }).catch(() => {})
  assert.equal(host.requests.length, 1, 'the refreshed pool holds no untried key')
})

// ---- sources ---------------------------------------------------------------

test('the key file is the fallback and one key per line joins the pool', async () => {
  const host = mount({
    keys: {},
    file: 'f1\n\n# a comment\nf2\n',
    reply: perKey({ f1: 402, f2: 200 }),
  })
  const out = await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(host.requests.length, 2)
  assert.deepEqual(host.requests.map(keyOf), ['f1', 'f2'])
  assert.match(out, /工作区 jina-api-key\.txt 第 2 行/, 'the note names the line the backup came from')
  assert.match(out, new RegExp(KEY_FILE.replace('.', '\\.')))
})

test('a credential slot wins over the key file: the first source with keys is the pool', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1' },
    file: 'f1\n',
    reply: perKey({ k1: 200 }),
  })
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(host.requests.length, 1)
  assert.equal(keyOf(host.requests[0]), 'k1')
  assert.deepEqual(host.fsCalls, [], 'the file is not even consulted while a credential key exists')
})

test('a single credential slot may itself hold several keys', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1\nk2' },
    reply: perKey({ k1: 402, k2: 200 }),
  })
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.deepEqual(host.requests.map(keyOf), ['k1', 'k2'])
})

test('the same key saved twice is requested once', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'same', JINA_API_KEY_2: 'same' },
    file: 'same\n',
    reply: envelope(402, 'quota'),
  })
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(host.requests.length, 1, 'a duplicated key must not be tried twice')
})

test('a key added on the card reaches the next call without a restart', async () => {
  const host = mount({ keys: {}, reply: perKey({ k1: 200 }) })
  await callTool(host, 'jina_web_search', { query: 'q' }).then(
    () => assert.fail('no key configured yet'),
    (e) => assert.match(e.message, /Jina API key required/),
  )
  assert.equal(host.requests.length, 0)

  // What the card's add does: the credential store answers with a new value on
  // the next resolve, which the plugin performs per operation.
  host.credentials.JINA_API_KEY = 'k1'
  const out = await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(host.requests.length, 1)
  assert.equal(keyOf(host.requests[0]), 'k1')
  assert.match(out, /example\.com/)
})

test('with no key anywhere the anonymous call is unchanged', async () => {
  const host = mount({ keys: {}, reply: envelope(200, JSON.stringify({ data: { title: 'Example', url: 'https://example.com' } })) })
  await callTool(host, 'jina_datetime', { url: 'https://example.com' })
  assert.equal(host.requests.length, 1)
  assert.equal('Authorization' in host.requests[0].headers, false, 'no key configured means no auth header')
})

test('a needs-key tool still reports the pool when nothing is configured', async () => {
  const host = mount({ keys: {}, reply: searchOk() })
  // A missing credential is a 401-shaped result, which 0.8.2 made fatal: the
  // model must fix its credential, not read the refusal as data.
  const err = await callTool(host, 'jina_web_search', { query: 'q' }).then(
    () => assert.fail('a missing key must throw'),
    (e) => e,
  )
  assert.equal(host.requests.length, 0)
  assert.match(err.message, /Jina API key required/)
  assert.match(err.message, /one or more keys/)
  assert.match(err.message, new RegExp('none of ' + KEY_REFS.length + ' set'), 'the lookup diagnosis names the slot count')
})

test('the OCR gate sees any pool slot, not just the primary one', async () => {
  const host = mount({
    keys: { JINA_API_KEY_2: 'k2' },
    reply: perKey({ k2: 200 }, { data: { title: 'Paper', url: 'https://example.com/p.pdf', content: 'body '.repeat(60) } }),
  })
  const out = await callTool(host, 'jina_read_pdf', { url: 'https://example.com/p.pdf', pages: '1' })
  assert.equal(host.requests.length, 1)
  assert.equal(keyOf(host.requests[0]), 'k2')
  assert.equal(host.requests[0].headers['X-Respond-With'], 'jina-ocr-v1')
  assert.match(out, /Paper/)
})

// ---- the card's health route -----------------------------------------------
// The page gets counts and one total, and nothing per key: no value, no
// fingerprint, no identity, no individual balance.

test('the primer route reports counts and the total, and discards what is dead', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'jina_0123456789abcdefghijklmnop', JINA_API_KEY_2: 'k2' },
    reply: (request) => {
      if (keyOf(request) === 'k2') return envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct-2', balanceLeft: 1234 } }))
      return envelope(402, 'quota exhausted')
    },
  })
  const payload = await callPrimerRoute(host)
  assert.equal(payload.keyCount, 1, 'the overdrawn key is no longer part of the pool')
  assert.equal(payload.balanceTotal, 1234, 'the total is the credits behind the surviving keys')
  assert.equal(payload.discardedCount, 1, 'the page can say one key was dropped')
  assert.equal(payload.keyFound, true)
  assert.equal(payload.keyKind, 'credential')
  assert.equal(payload.settingsLive, true)
  assert.deepEqual(host.unsets, ['JINA_API_KEY'])
  assert.equal(host.credentials.JINA_API_KEY, undefined)
  // Nothing per key may cross the wire.
  assert.equal('keys' in payload, false)
  assert.equal('activeKey' in payload, false)
  const body = JSON.stringify(payload)
  assert.equal(body.includes('jina_0123456789abcdefghijklmnop'), false, 'no key value')
  assert.equal(body.includes('jina…mnop'), false, 'not even a fingerprint')
  assert.equal(body.includes('JINA_API_KEY'), false, 'not even a reference name')
})

test('a key whose balance is zero is discarded by the probe', async () => {
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: (request) => (keyOf(request) === 'k1'
      ? envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct-1', balanceLeft: 0 } }))
      : envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct-2', balanceLeft: 500 } }))),
  })
  const payload = await callPrimerRoute(host)
  assert.deepEqual(host.unsets, ['JINA_API_KEY'], 'quota <= 0 is discarded, exactly as asked')
  assert.equal(payload.discardedCount, 1)
  assert.equal(payload.keyCount, 1)
  assert.equal(payload.balanceTotal, 500, 'the discarded key contributes nothing')
  // The headline probe must describe a key that is still there: the discarded
  // one answered 200, and using it would report the wrong account.
  assert.equal(payload.authenticatedAs, 'acct-2')
  assert.equal(payload.balanceLeft, 500)
})

test('a rate-limited key is parked by the probe rather than discarded, and recovers', async () => {
  const statuses = { k1: 429 }
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: (request) => (keyOf(request) === 'k1' && statuses.k1 === 429
      ? envelope(429, 'slow down')
      : envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: 10 } }))),
  })
  const before = await callPrimerRoute(host)
  assert.equal(before.discardedCount, 0, 'a temporary rate limit must not delete a working key')
  assert.equal(before.keyCount, 2)
  assert.equal(host.credentials.JINA_API_KEY, 'k1', 'the key stays stored')

  // The rate limit lifts: the next probe puts the key straight back.
  statuses.k1 = 200
  const after = await callPrimerRoute(host)
  assert.equal(after.discardedCount, 0)

  // And the failover walk starts from the first slot again.
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal(keyOf(host.requests[host.requests.length - 1]), 'k1')
})

test('the primer route reports an empty pool for an unconfigured profile', async () => {
  const host = mount({
    keys: {},
    reply: envelope(200, JSON.stringify({ data: { authenticatedAs: '', balanceLeft: 0 } })),
  })
  const payload = await callPrimerRoute(host)
  assert.equal(payload.keyCount, 0)
  assert.equal(payload.discardedCount, 0)
  assert.equal(payload.balanceTotal, null, 'no key reported a balance, so the page must say "unknown" not "0"')
  assert.equal(payload.keyFound, false)
  assert.equal(payload.keyKind, undefined)
  assert.deepEqual(host.unsets, [])
})

// ---- the balance ledger -----------------------------------------------------
// One number, shared: the card's health check and the low-balance notice read
// the same ledger instead of each probing the vendor on its own clock. The host
// owns when a probe is due, because the host is where the calls that spend
// credits actually happen.
//
// The rule under test is a window anchored at the *first* call after the last
// probe. A probe taken immediately after a call still reads the pre-call number
// (the vendor does not settle instantly), so the window is what makes the
// reading mean anything — and because calls inside an open window do not
// reschedule it, a burst yields one probe and an unbroken stream of calls still
// yields one per window. It cannot starve, which is why there is no
// deferred-maximum escape hatch.

test('the balance route is a pure read of memory: no call, no probe, nothing to report', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = mount({
    keys: { JINA_API_KEY: 'k1' },
    reply: envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: 1000 } })),
  })
  const ledger = await callBalanceRoute(host)
  assert.equal(ledger.total, null, 'nothing has confirmed a balance yet, so the page is told "unknown"')
  assert.equal(ledger.updatedAt, 0, 'and is told when it will know')
  assert.equal(ledger.pending, false, 'no window is open: no call, nothing to confirm later')
  assert.deepEqual(host.requests, [], 'reading the ledger must not reach the vendor')

  // Time alone changes nothing. Without calls there is nothing spending credits,
  // so there is nothing to re-read — which is why this feature has no periodic
  // poll to keep honest.
  t.mock.timers.tick(60 * 60 * 1000)
  await settleAsync()
  assert.deepEqual(host.requests, [], 'an hour of idling probes nothing')
  assert.equal((await callBalanceRoute(host)).total, null)
})

test('a call opens a window, and the probe lands one window later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: (request) => (isProbe(request)
      ? envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: 700 } }))
      : envelope(200, JSON.stringify({ results: [{ title: 'hit', url: 'https://example.com' }] }))),
  })

  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.deepEqual(probesOf(host), [], 'the call itself must not probe — that would read the pre-call number')
  assert.equal((await callBalanceRoute(host)).pending, true, 'the window is open and waiting')

  t.mock.timers.tick(59_000)
  await settleAsync()
  assert.deepEqual(probesOf(host), [], 'one second short of the window: still nothing')

  t.mock.timers.tick(1_000)
  await settleAsync()
  assert.deepEqual(probesOf(host), ['k1'], 'and at the window it probes the key that served the call')

  const ledger = await callBalanceRoute(host)
  assert.equal(ledger.total, 700, 'the confirmed figure is now the number the page reads')
  assert.ok(ledger.updatedAt > 0, 'and it is dated')
  assert.equal(ledger.pending, false, 'the window closed with the probe')
})

test('a burst of calls inside one window produces exactly one probe', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = mount({
    keys: { JINA_API_KEY: 'k1' },
    reply: (request) => (isProbe(request)
      ? envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: 700 } }))
      : envelope(200, JSON.stringify({ results: [{ title: 'hit', url: 'https://example.com' }] }))),
  })

  // Ten calls spread over the window. None of them may reschedule it.
  for (let i = 0; i < 10; i++) {
    await callTool(host, 'jina_web_search', { query: 'q' })
    t.mock.timers.tick(5_000)
    await settleAsync()
  }
  assert.deepEqual(probesOf(host), [], '50s in, half a window of calls and still nothing')

  t.mock.timers.tick(10_000) // T+60s: the window boundary
  await settleAsync()
  assert.deepEqual(probesOf(host), ['k1'], 'the whole burst is confirmed by one probe, at the window boundary')
})

test('a call inside an open window does not push the probe back', async (t) => {
  // This is the distinction the window rule turns on. If calls rescheduled the
  // probe, a steady stream of work would postpone it forever and the number
  // would never be re-read — exactly when the balance is moving fastest.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = mount({
    keys: { JINA_API_KEY: 'k1' },
    reply: (request) => (isProbe(request)
      ? envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: 700 } }))
      : envelope(200, JSON.stringify({ results: [{ title: 'hit', url: 'https://example.com' }] }))),
  })

  await callTool(host, 'jina_web_search', { query: 'q' })
  t.mock.timers.tick(50_000)
  // Ten seconds before the window closes, another call lands.
  await callTool(host, 'jina_web_search', { query: 'q' })

  t.mock.timers.tick(10_000) // T+60s: the window opened at T, so this is it
  await settleAsync()
  assert.deepEqual(probesOf(host), ['k1'], 'the probe lands on the original window, not 60s later')

  // The late call did not schedule a second probe of its own.
  t.mock.timers.tick(10 * 60 * 1000)
  await settleAsync()
  assert.deepEqual(probesOf(host), ['k1'], 'and it did not leave a trailing probe behind')
})

test('only the keys a window used are probed; the rest keep their cached balance', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2', JINA_API_KEY_3: 'k3' },
    reply: (request) => {
      if (!isProbe(request)) return envelope(200, JSON.stringify({ results: [{ title: 'hit', url: 'https://example.com' }] }))
      const balance = { k1: 111, k2: 222, k3: 333 }[keyOf(request)]
      return envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: balance } }))
    },
  })

  // One full read first, so every key has a cached balance.
  await callPrimerRoute(host)
  assert.equal((await callBalanceRoute(host)).total, 666, 'the health check is a full read of the pool')

  // Now one call, served by exactly one key.
  host.requests.length = 0
  await callTool(host, 'jina_web_search', { query: 'q' })
  const served = keyOf(host.requests[host.requests.length - 1])
  t.mock.timers.tick(60_000)
  await settleAsync()
  assert.deepEqual(probesOf(host), [served], 'exactly one key is asked about — the one that spent')
  const ledger = await callBalanceRoute(host)
  assert.equal(ledger.total, 666, 'and the total still covers all three: the untouched keys keep their credits')
})

test('a discarded key stops counting immediately, without a probe', async (t) => {
  // A 402 means the account is at zero by definition, so there is nothing to ask
  // about: its credits simply stop backing the pool. Waiting for the window
  // would leave the total inflated for up to a minute, on exactly the call that
  // just proved the key was empty.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const live = { k1: 1000, k2: 500, k1Status: 200 }
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: (request) => {
      if (keyOf(request) === 'k1' && live.k1Status === 402) return envelope(402, 'quota exhausted')
      if (isProbe(request)) {
        return envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: live[keyOf(request)] } }))
      }
      return envelope(200, JSON.stringify({ results: [{ title: 'hit', url: 'https://example.com' }] }))
    },
  })

  assert.equal((await callPrimerRoute(host)).balanceTotal, 1500, 'the pool starts at 1500')
  host.requests.length = 0

  live.k1Status = 402
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.deepEqual(host.unsets, ['JINA_API_KEY'], 'the 402 key is deleted, exactly as on the call path')

  const ledger = await callBalanceRoute(host)
  assert.equal(ledger.total, 500, 'the discarded key contributes nothing the instant it leaves the pool')
  assert.deepEqual(probesOf(host), [], 'and nothing was probed to find that out')

  // A key the seam refuses to delete (a read-only environment slot, or a key
  // from `jina-api-key.txt`) stays in the pool — the walk only skips it — but a
  // 401/402 is a verdict, not a reading: it cannot serve, so its credits stop
  // backing the total here too. This has to be driven through a *probe* that
  // answers 402: the earlier version of this check returned 402 only to
  // non-probe requests, and `callPrimerRoute` issues nothing but probes, so it
  // never reached `discardKey` at all and simply re-read the number it had just
  // written. (The primer's own probe is the cheap way to make the key answer.)
  const readonly = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    unsetFails: true,
    reply: (request) => (isProbe(request)
      ? (keyOf(request) === 'k1'
          ? envelope(402, 'quota exhausted')
          : envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: 500 } })))
      : envelope(200, JSON.stringify({ results: [{ title: 'hit', url: 'https://example.com' }] }))),
  })
  const readonlyPrimer = await callPrimerRoute(readonly)
  assert.deepEqual(readonly.unsets, ['JINA_API_KEY'], 'the seam was asked to delete the dry key')
  assert.equal(readonlyPrimer.balanceTotal, 500, 'and it stopped counting even though the delete was refused')
  assert.equal((await callBalanceRoute(readonly)).total, 500, 'the ledger agrees with the route that read it')

  // The same rule on the *call* path, where the walk (not the health check) is
  // what discovers the 402.
  const callPath = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    unsetFails: true,
    reply: (request) => {
      if (!isProbe(request)) return keyOf(request) === 'k1' ? envelope(402, 'quota exhausted') : searchOk()
      return envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: 1000 } }))
    },
  })
  assert.equal((await callPrimerRoute(callPath)).balanceTotal, 2000, 'both keys are counting to start with')
  await callTool(callPath, 'jina_web_search', { query: 'q' })
  assert.deepEqual(callPath.unsets, ['JINA_API_KEY'], 'the call path asked the seam to delete it')
  assert.equal((await callBalanceRoute(callPath)).total, 1000, 'and the undeletable dry key stopped counting anyway')
})

test('a probe that answers 402 stops that key counting, without deleting it', async (t) => {
  // The window probe is the third path that can meet a 402, and the one the
  // health check is not around to cover. A key that runs dry between the call
  // and the probe (60s later) must stop backing the total then — otherwise the
  // figure stays inflated by a key that just proved it is empty.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.mock.timers.setTime(1_750_000_000_000)
  const live = { balance: 1000, status: 200 }
  const host = mount({
    keys: { JINA_API_KEY: 'k1' },
    reply: (request) => {
      if (!isProbe(request)) return searchOk()
      if (live.status === 402) return envelope(402, 'quota exhausted')
      return envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: live.balance } }))
    },
  })

  await callPrimerRoute(host)
  assert.equal((await callBalanceRoute(host)).total, 1000)
  live.status = 402
  await callTool(host, 'jina_web_search', { query: 'q' })
  t.mock.timers.tick(60_000) // the clock is already at the call's own instant
  await settleAsync()

  assert.deepEqual(host.unsets, [], 'the window probe must not delete a key the health check may be looking at')
  const ledger = await callBalanceRoute(host)
  assert.equal(ledger.total, null, 'but the dry key stops backing the pool the moment the probe says so')
  assert.equal(ledger.updatedAt, 1_750_000_060_000, 'and that is a real account of the total, so it is dated')
})

test('dropping a key that never contributed must not re-date the total', async (t) => {
  // A key with no cached figure adds nothing to the total, so removing it does
  // not change the number the page reads — and a number that did not move must
  // not be stamped as freshly confirmed, or the *other* keys' older figure gets
  // dressed up as current.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.mock.timers.setTime(1_750_000_000_000)
  let k1ProbeKilled = true
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: (request) => {
      if (!isProbe(request)) return keyOf(request) === 'k1' ? envelope(402, 'quota exhausted') : searchOk()
      if (keyOf(request) === 'k1' && k1ProbeKilled) return envelope(0, 'transport failure')
      return envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: keyOf(request) === 'k1' ? 111 : 500 } }))
    },
  })

  const first = await callPrimerRoute(host)
  assert.equal(first.balanceTotal, 500, 'k1 survived the health check but reported nothing')
  assert.equal(first.balanceUpdatedAt, 1_750_000_000_000)
  k1ProbeKilled = false

  t.mock.timers.setTime(1_750_007_200_000) // two hours later
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.deepEqual(host.unsets, ['JINA_API_KEY'], 'the dry key is deleted')

  const ledger = await callBalanceRoute(host)
  assert.equal(ledger.total, 500, 'the total is unmoved: the dropped key contributed nothing')
  assert.equal(ledger.updatedAt, first.balanceUpdatedAt, 'so the surviving figure keeps its real age')
})

test('the health check writes its full read into the ledger, so the notice needs no poll of its own', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = mount({
    keys: { JINA_API_KEY: 'k1', JINA_API_KEY_2: 'k2' },
    reply: (request) => {
      if (!isProbe(request)) return envelope(200, JSON.stringify({ results: [{ title: 'hit', url: 'https://example.com' }] }))
      const balance = { k1: 4000, k2: 6000 }[keyOf(request)]
      return envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: balance } }))
    },
  })

  assert.equal((await callBalanceRoute(host)).total, null)
  const payload = await callPrimerRoute(host)
  assert.equal(payload.balanceTotal, 10000)
  assert.ok(payload.balanceUpdatedAt > 0, 'and the payload is dated, so the card can show the age')

  const ledger = await callBalanceRoute(host)
  assert.equal(ledger.total, 10000, 'the two routes report one number, from one ledger')
  assert.equal(ledger.updatedAt, payload.balanceUpdatedAt, 'and one timestamp, so they cannot disagree')
})

test('a probe round that confirms nothing must not date the number it did not read', async (t) => {
  // `updatedAt` answers "how long ago was this figure confirmed", and the UI
  // renders it as 刚刚更新 / N 分钟前更新. Stamping it on a round where every
  // probe failed would dress a stale number up as a fresh one — the single lie
  // an age line exists to prevent, and the one a user cannot detect, because the
  // figure itself is correct-looking and merely old.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.mock.timers.setTime(1_750_000_000_000)
  let probeFails = false
  let shapeOnly = false
  const host = mount({
    keys: { JINA_API_KEY: 'k1' },
    reply: (request) => {
      if (!isProbe(request)) return envelope(200, JSON.stringify({ results: [{ title: 'hit', url: 'https://example.com' }] }))
      if (probeFails) return envelope(0, 'transport failure')
      if (shapeOnly) return envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct' } }))
      return envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: 500 } }))
    },
  })

  await callPrimerRoute(host)
  const confirmed = await callBalanceRoute(host)
  assert.equal(confirmed.total, 500)
  assert.equal(confirmed.updatedAt, 1_750_000_000_000, 'the health check confirmed the figure')

  // (a) the window's probe fails at the transport: the total stays, its age does not reset
  probeFails = true
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal((await callBalanceRoute(host)).pending, true, 'the call still opened its window')
  t.mock.timers.setTime(1_750_000_060_000)
  t.mock.timers.tick(60_000)
  await settleAsync()
  const afterFailure = await callBalanceRoute(host)
  assert.equal(afterFailure.total, 500, 'the last known figure is kept')
  assert.equal(afterFailure.updatedAt, 1_750_000_000_000, 'but it is not re-dated: nothing was confirmed')
  assert.equal(afterFailure.pending, false, 'and the window closed, so a failure cannot wedge it open')

  // (b) a probe that answers 200 without a balance number is equally no confirmation
  probeFails = false
  shapeOnly = true
  await callTool(host, 'jina_web_search', { query: 'q' })
  t.mock.timers.setTime(1_750_000_120_000)
  t.mock.timers.tick(60_000)
  await settleAsync()
  const afterShapeless = await callBalanceRoute(host)
  assert.equal(afterShapeless.total, 500)
  assert.equal(afterShapeless.updatedAt, 1_750_000_000_000, 'a shapeless answer confirms nothing either')

  // (c) a full health check with every probe failing is no confirmation either
  shapeOnly = false
  probeFails = true
  t.mock.timers.setTime(1_750_000_180_000)
  const failedCheck = await callPrimerRoute(host)
  assert.equal(failedCheck.balanceTotal, 500, 'the card still shows the last known figure')
  assert.equal(failedCheck.balanceUpdatedAt, 1_750_000_000_000, 'but does not claim it was just checked')

  // (d) the next real confirmation moves it — the age is only frozen, not dead
  probeFails = false
  t.mock.timers.setTime(1_750_000_240_000)
  const recovered = await callPrimerRoute(host)
  assert.equal(recovered.balanceTotal, 500)
  assert.equal(recovered.balanceUpdatedAt, 1_750_000_240_000, 'a probe that does read the figure dates it')
})

test('a window that confirmed nothing still opens a fresh one on the next call', async (t) => {
  // The recovery the previous test depends on: a failed round closes its window
  // for good rather than leaving `pending` stuck true, which would stop every
  // later probe from being scheduled.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.mock.timers.setTime(1_750_000_000_000)
  let probeFails = true
  const host = mount({
    keys: { JINA_API_KEY: 'k1' },
    reply: (request) => {
      if (!isProbe(request)) return envelope(200, JSON.stringify({ results: [{ title: 'hit', url: 'https://example.com' }] }))
      return probeFails
        ? envelope(0, 'transport failure')
        : envelope(200, JSON.stringify({ data: { authenticatedAs: 'acct', balanceLeft: 123 } }))
    },
  })

  await callTool(host, 'jina_web_search', { query: 'q' })
  t.mock.timers.setTime(1_750_000_060_000)
  t.mock.timers.tick(60_000)
  await settleAsync()
  assert.equal((await callBalanceRoute(host)).pending, false)

  probeFails = false
  await callTool(host, 'jina_web_search', { query: 'q' })
  assert.equal((await callBalanceRoute(host)).pending, true, 'the next call opens a new window')
  t.mock.timers.tick(60_000)
  await settleAsync()
  const ledger = await callBalanceRoute(host)
  assert.equal(ledger.total, 123, 'and its probe lands and is recorded')
  assert.equal(ledger.updatedAt, 1_750_000_180_000)
})

test('the declared slots are exactly the pool the host resolves', async () => {
  // The card names the references itself (the credentials namespace has no
  // enumeration), so the two halves must agree; this pins the host's half.
  const host = mount({ keys: {}, reply: searchOk() })
  await callTool(host, 'jina_web_search', { query: 'q', apiKey: 'k' }).catch(() => {})
  const resolved = []
  const spy = createHost({ keys: {}, reply: searchOk() })
  const originalGet = spy.ctx.get
  spy.ctx.get = (key) => {
    const service = originalGet(key)
    if (key === 'credentials') {
      return {
        async resolve(ref) { resolved.push(ref); return undefined },
      }
    }
    return service
  }
  apply(spy.ctx, resolveSettings({}))
  await callTool(spy, 'jina_web_search', { query: 'q' }).catch(() => {})
  assert.deepEqual(resolved, KEY_REFS)
  assert.ok(host.tools.has('jina_web_search'))
})
