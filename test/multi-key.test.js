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
