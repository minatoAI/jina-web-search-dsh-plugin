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
 *   - the valid path is untouched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** One Jina search response, as the network helper hands it back. */
function searchBody() {
  return JSON.stringify({
    ok: true,
    status: 200,
    text: JSON.stringify({ results: [{ title: 'Wake word detection', url: 'https://example.com/kws', snippet: 'snippet' }] }),
  })
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

/** Fake host context: records every helper request; no key, no fs, no settings. */
function createHost() {
  const helpers = []
  const tools = new Map()
  const ctx = {
    get(key) {
      if (key === 'sandboxPolicy') return { workspaceRoot: 'C:\\ws' }
      return undefined
    },
    inject(keys, callback) {
      if (keys.includes('settings')) callback({ settings: { register: () => ({ get: () => ({}) }) } })
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
        helpers.push(JSON.parse(stdin))
        return fakeHandle(searchBody())
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
  apply(host.ctx)
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
  apply(host.ctx)
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
  apply(host.ctx)
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
