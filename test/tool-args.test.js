/**
 * Regression tests for argument validation (0.8.0).
 *
 * The live failure these pin: a session called `jina_web_search` with
 * `{"queries": [...], "num": 6}`. The built-in `web_search` takes `queries`,
 * this tool takes `query`, and `ctx.tools.register` never enforces the declared
 * schema, so `String(args.query)` became the literal search term "undefined"
 * and Jina returned MDN's `undefined` page as a normal, `isError: false`
 * result — well-formed enough that the model only caught it by reading the
 * snippets.
 *
 * The contract asserted here:
 *   - a missing, blank or wrongly typed required argument throws (the harness
 *     turns a thrown error into `isError: true`; a returned string stays a
 *     successful result the model may treat as data),
 *   - the message names the tool, the parameter, and the likely typo,
 *   - nothing is spawned for arguments the tool already rejected,
 *   - the valid path is untouched,
 *   - (0.8.2) a non-http(s) `url` throws too, instead of the old
 *     `invalid url: undefined` string the model could read as data,
 *   - (0.8.2) a key-gated pipeline (readerlm-v2 / jina_read_pdf) without a key
 *     throws for the same reason,
 *   - (0.8.2) an upstream 401/422 throws, while 0/402/429/5xx stay returned
 *     hints — and `jina_primer` keeps its "never throws" contract.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, apply } from '../index.js'

/** Resolve one raw stored settings section the way the Loader does before apply(). */
function resolveSettings(raw) {
  return Config['~standard'].validate(raw === undefined ? {} : raw).value
}

/** One Jina search response, as the network helper hands it back. */
function searchBody() {
  return JSON.stringify({
    ok: true,
    status: 200,
    text: JSON.stringify({ results: [{ title: 'Wake word detection', url: 'https://example.com/kws', snippet: 'snippet' }] }),
  })
}

/** One HTTP reply envelope, exactly as the network helper writes it. */
function envelope(status, text) {
  return JSON.stringify({ ok: status >= 200 && status < 300, status, text })
}

/** One Reader JSON payload, long enough that the selector retry does not fire. */
function readerBody(url) {
  return envelope(200, JSON.stringify({
    code: 200,
    data: { title: 'Example', url, publishedTime: '2026-01-01T00:00:00Z', content: 'body text '.repeat(40) },
  }))
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

/**
 * Fake host context: records every helper request; no key, no fs, no settings.
 * `reply` is the helper's stdout for every HTTP spawn — a JSON envelope string
 * or a function of the parsed request; it defaults to one successful search.
 */
function createHost(reply) {
  const helpers = []
  const tools = new Map()
  const ctx = {
    get(key) {
      if (key === 'sandboxPolicy') return { workspaceRoot: 'C:\\ws' }
      return undefined
    },
    inject(keys, callback) {
      if (keys.includes('webServer')) callback({ webServer: { register() {} } })
    },
    fs: {
      async resolve(path) { throw new Error('ENOENT ' + path) },
      async readText() { throw new Error('ENOENT') },
    },
    subprocess: {
      async resolveExecutable() { return process.execPath },
      spawn(spec) {
        if (spec.argv[1] !== '-e') return fakeHandle('') // WinINET discovery probe
        const stdin = spec.stdio && spec.stdio.stdin && typeof spec.stdio.stdin === 'object'
          ? spec.stdio.stdin.data
          : undefined
        const request = JSON.parse(stdin)
        helpers.push(request)
        return fakeHandle(reply === undefined ? searchBody() : typeof reply === 'function' ? reply(request) : reply)
      },
    },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }
  return { ctx, helpers, tools }
}

/** Invoke one registered tool the way the tool seam does. */
function callTool(host, name, args) {
  const tool = host.tools.get(name)
  assert.ok(tool !== undefined, name + ' must be registered')
  return tool.execute(args, { agent: { session: { header: { cwd: 'C:\\ws' } } } })
}

/** Mount the plugin, call `name` with `args`, and assert it was rejected. */
async function rejected(name, args, pattern) {
  const host = createHost()
  apply(host.ctx, resolveSettings({}))
  await assert.rejects(() => callTool(host, name, args), pattern)
  assert.equal(host.helpers.length, 0, 'a rejected call must not spend a request')
  return host
}

test('jina_web_search: the live failure — `queries` instead of `query` — is rejected', async () => {
  await rejected('jina_web_search', {
    queries: ['wake word detection keyword spotting KWS difference from ASR terminology', 'keyword spotting KWS on-device architecture'],
    num: 6,
  }, /invalid arguments: jina_web_search requires a non-empty "query" string/)
})

test('jina_web_search: the rejection tells the model which key it actually sent', async () => {
  const host = createHost()
  apply(host.ctx, resolveSettings({}))
  const err = await callTool(host, 'jina_web_search', { queries: ['a', 'b'], num: 6 }).then(
    () => assert.fail('a bare `queries` call must be rejected'),
    (e) => e,
  )
  assert.match(err.message, /did you mean "query" instead of "queries"/)
  assert.match(err.message, /arguments received: queries, num/)
  assert.equal(err.message.includes('undefined'), false, 'the message must not reproduce the old silent `undefined` query')
})

test('jina_web_search: absent, blank and wrongly typed queries are all rejected', async () => {
  await rejected('jina_web_search', {}, /requires a non-empty "query" string, but got nothing/)
  await rejected('jina_web_search', { query: '' }, /requires a non-empty "query" string/)
  await rejected('jina_web_search', { query: '   ' }, /requires a non-empty "query" string/)
  await rejected('jina_web_search', { query: 42 }, /requires a non-empty "query" string, but got \(number\) 42/)
  await rejected('jina_web_search', undefined, /requires a non-empty "query" string, but got nothing/)
})

test('jina_web_search: a valid query still reaches the API unchanged', async () => {
  const host = createHost()
  apply(host.ctx, resolveSettings({}))
  const out = await callTool(host, 'jina_web_search', { query: 'wake word detection', num: 6, apiKey: 'k' })
  assert.equal(host.helpers.length, 1)
  const body = JSON.parse(host.helpers[0].body)
  assert.equal(body.q, 'wake word detection')
  assert.equal(body.num, 6)
  assert.match(out, /example\.com/, 'the formatted result still comes back')
})

test('the academic search tools are guarded under their own names', async () => {
  await rejected('jina_search_arxiv', { queries: ['x'] }, /jina_search_arxiv requires a non-empty "query" string/)
  await rejected('jina_search_ssrn', {}, /jina_search_ssrn requires a non-empty "query" string/)
})

test('jina_expand: a missing query is rejected instead of expanding "undefined"', async () => {
  await rejected('jina_expand', { queries: ['x'] }, /jina_expand requires a non-empty "query" string/)
})

test('jina_embed / jina_classify: a missing or malformed texts array is rejected', async () => {
  await rejected('jina_embed', {}, /jina_embed requires a non-empty array of strings in "texts", but got nothing/)
  await rejected('jina_embed', { texts: [] }, /jina_embed requires a non-empty array of strings in "texts"/)
  await rejected('jina_embed', { texts: ['ok', 7] }, /jina_embed requires a non-empty array of strings in "texts"/)
  await rejected('jina_embed', { texts: 'one string' }, /jina_embed requires a non-empty array of strings in "texts"/)
  await rejected('jina_classify', { texts: ['t'] }, /jina_classify requires a non-empty array of strings in "labels"/)
})

test('jina_rerank: both the query and the documents are required', async () => {
  await rejected('jina_rerank', { documents: ['d'] }, /jina_rerank requires a non-empty "query" string/)
  await rejected('jina_rerank', { query: 'q' }, /jina_rerank requires a non-empty array of strings in "documents"/)
})

test('jina_pdf: neither url nor arxivId is a hard error, not a successful-looking string', async () => {
  await rejected('jina_pdf', {}, /jina_pdf requires either a "url" or an "arxivId"/)
})

// ---- 0.8.2: the URL guard and the error channel -----------------------------
// Before 0.8.2 a bad `url` came back as the *string* `invalid url: undefined`,
// and an upstream 401/422 came back as a hint string. Both are successful tool
// results: the model can read them as page content and keep going. They throw now.

test('jina_read: a missing url is rejected instead of reading "undefined"', async () => {
  await rejected('jina_read', {}, /invalid arguments: jina_read requires an http\(s\) "url" string, but got nothing \(arguments received: no arguments\)/)
  await rejected('jina_read', undefined, /jina_read requires an http\(s\) "url" string, but got nothing \(arguments received: nothing\)/)
})

test('jina_read: a non-http url is rejected before any request', async () => {
  await rejected('jina_read', { url: 'example.com' }, /requires an http\(s\) "url" string, but got \(string\) "example\.com"/)
  await rejected('jina_read', { url: 'ftp://example.com/x' }, /requires an http\(s\) "url" string/)
})

test('jina_screenshot: a wrongly typed url is rejected and names the type it got', async () => {
  await rejected('jina_screenshot', { url: 42 }, /jina_screenshot requires an http\(s\) "url" string, but got \(number\) 42/)
})

test('jina_datetime: a `uri` argument is rejected with the rename hint', async () => {
  await rejected('jina_datetime', { uri: 'https://example.com' }, /did you mean "url" instead of "uri"\?/)
})

test('jina_read: a valid url still reaches the Reader unchanged', async () => {
  const host = createHost(readerBody('https://example.com/a'))
  apply(host.ctx, resolveSettings({}))
  const out = await callTool(host, 'jina_read', { url: 'https://example.com/a' })
  assert.equal(host.helpers.length, 1, 'a long body must not trigger the selector retry')
  assert.equal(JSON.parse(host.helpers[0].body).url, 'https://example.com/a')
  assert.match(out, /Title: Example/, 'the markdown still comes back')
})

test('jina_read: readerlm without a key throws instead of returning a refusal string', async () => {
  await rejected('jina_read', { url: 'https://example.com', readerlm: true }, /readerlm requires a Jina API key/)
})

test('jina_read_pdf: without a key throws instead of returning a refusal string', async () => {
  await rejected('jina_read_pdf', { url: 'https://example.com/paper.pdf' }, /jina_read_pdf requires a Jina API key/)
})

test('an upstream 401 throws: a credential problem must not look like data', async () => {
  const host = createHost(envelope(401, 'Authentication is required to use this feature'))
  apply(host.ctx, resolveSettings({}))
  await assert.rejects(
    () => callTool(host, 'jina_web_search', { query: 'wake word detection', apiKey: 'stale' }),
    /Jina API error \(HTTP 401\)/,
  )
  assert.equal(host.helpers.length, 1)
})

test('an upstream 422 throws: the model has to change its arguments', async () => {
  const host = createHost(envelope(422, '{"detail":"Invalid request parameters"}'))
  apply(host.ctx, resolveSettings({}))
  const err = await callTool(host, 'jina_web_search', { query: 'q', apiKey: 'k' }).then(
    () => assert.fail('422 must throw'),
    (e) => e,
  )
  assert.match(err.message, /Jina API error \(HTTP 422\)/)
  assert.match(err.message, /Invalid request parameters/)
  assert.match(err.message, /Server said:/, 'the upstream body still comes back')
})

test('an upstream 429 still returns a relayable hint instead of throwing', async () => {
  const host = createHost(envelope(429, 'rate limited'))
  apply(host.ctx, resolveSettings({}))
  const out = await callTool(host, 'jina_web_search', { query: 'q', apiKey: 'k' })
  assert.equal(typeof out, 'string', '429 is environmental: the model relays it, it does not fix its call')
  assert.match(out, /Jina API error \(HTTP 429\)/)
  assert.match(out, /Rate limit hit/)
})

test('jina_primer: a failing probe degrades to "unavailable" instead of throwing', async () => {
  const host = createHost(envelope(0, ''))
  apply(host.ctx, resolveSettings({}))
  const out = await callTool(host, 'jina_primer', {})
  assert.equal(typeof out, 'string', 'the primer contract is "never throws"')
  assert.match(out, /Jina: unavailable/)
  assert.match(out, /Network: unavailable/)
})
