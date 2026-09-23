/**
 * Contract tests for `jina_read`'s Reader request policy (0.8.0).
 *
 * Every assertion here is about the bytes that actually reach the network
 * helper: the host half is driven through a fake Cordis context and the
 * helper's stdin payload is decoded, so a header that is built but never sent
 * (or sent with the wrong value) fails here.
 *
 * What is pinned:
 *   - the three "no-regret" Reader parameters every read sends
 *     (`X-Preset: agent`, `X-Base: final`, `X-Timeout: 120`),
 *   - `X-Retain-Images` following the settings policy instead of a hardcoded
 *     `none` (the API default is `all`),
 *   - the selector group, including the retry that keeps a target selector
 *     from turning into an empty page,
 *   - `jina-ocr-v1`: opt-in, key-gated (the Reader rejects it for anonymous
 *     callers), page-steerable, and mutually exclusive with alt generation,
 *   - `X-With-Generated-Alt`: opt-in only, because supplying a key is what
 *     makes a read billable.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import {
  DEFAULT_IMAGE_POLICY, DEFAULT_REMOVE_SELECTORS, DEFAULT_TARGET_SELECTORS,
  READER_BASE, READER_PRESET, READER_TIMEOUT_SECONDS,
  createSettingsSchema, toolSettingsOf,
} from '../proxy.js'

/** One Reader JSON envelope, as the network helper hands it back. */
function readerBody(content, title = 'Example') {
  return JSON.stringify({
    ok: true,
    status: 200,
    text: JSON.stringify({ data: { title, url: 'https://example.com', content }, usage: { tokens: 42 } }),
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

/**
 * Fake host context: records every helper request, answers from `responses`
 * (the last entry repeats), and resolves no API key — `ctx.fs` throws and the
 * credential service is absent, exactly like a profile with nothing configured.
 */
function createHost(options = {}) {
  const requests = []
  const tools = new Map()
  const queue = [...(options.responses || [readerBody('hello world '.repeat(40))])]
  const settingsValue = options.setting === undefined ? {} : options.setting
  const ctx = {
    get(key) {
      if (key === 'sandboxPolicy') return { workspaceRoot: 'C:\\ws' }
      return undefined
    },
    inject(keys, callback) {
      if (keys.includes('settings')) {
        callback({ settings: { register: () => ({ get: () => settingsValue }) } })
      }
      if (keys.includes('webServer')) callback({ webServer: { register() {} } })
    },
    fs: {
      async resolve(path) { throw new Error('ENOENT ' + path) },
      async readText() { throw new Error('ENOENT') },
    },
    subprocess: {
      async resolveExecutable() { return process.execPath },
      spawn(spec) {
        const stdin = spec.stdio && spec.stdio.stdin && typeof spec.stdio.stdin === 'object'
          ? spec.stdio.stdin.data
          : undefined
        if (spec.argv[1] !== '-e') return fakeHandle('') // WinINET discovery probe
        requests.push(JSON.parse(stdin))
        return fakeHandle(queue.length > 1 ? queue.shift() : queue[0])
      },
    },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }
  return { ctx, requests, tools }
}

/** Invoke `jina_read` the way the tool seam does. */
function callRead(host, args) {
  const tool = host.tools.get('jina_read')
  assert.ok(tool !== undefined, 'jina_read must be registered')
  return tool.execute(args, { agent: { session: { header: { cwd: 'C:\\ws' } } } })
}

/** Mount the plugin and return the host plus its first request's headers. */
async function headersFor(args, setting) {
  const host = createHost({ setting })
  apply(host.ctx)
  await callRead(host, args)
  assert.equal(host.requests.length >= 1, true, 'a request must reach the helper')
  return { host, headers: host.requests[0].headers }
}

test('jina_read: every read sends the agent preset, the final-URL base and the max timeout', async () => {
  const { headers } = await headersFor({ url: 'https://example.com' })
  assert.equal(headers['X-Preset'], READER_PRESET)
  assert.equal(headers['X-Base'], READER_BASE)
  assert.equal(headers['X-Timeout'], String(READER_TIMEOUT_SECONDS))
  assert.equal(headers.Accept, 'application/json')
})

test('jina_read: keeps images by default instead of the old hardcoded none', async () => {
  const { headers } = await headersFor({ url: 'https://example.com' })
  assert.equal(headers['X-Retain-Images'], DEFAULT_IMAGE_POLICY)
  assert.equal(DEFAULT_IMAGE_POLICY, 'all', 'the API default is `all`')
})

test('jina_read: the selector group strips chrome and targets the article container', async () => {
  const { headers } = await headersFor({ url: 'https://example.com' })
  assert.equal(headers['X-Target-Selector'], DEFAULT_TARGET_SELECTORS)
  assert.equal(headers['X-Remove-Selector'], DEFAULT_REMOVE_SELECTORS)
  assert.equal(headers['X-Wait-For-Selector'], undefined, 'no wait selector unless configured')
})

test('jina_read: per-call selectors and noCache override the defaults', async () => {
  const { headers } = await headersFor({
    url: 'https://example.com',
    targetSelector: 'article.post',
    waitForSelector: '#app',
    removeSelector: '.ads',
    noCache: true,
  })
  assert.equal(headers['X-Target-Selector'], 'article.post')
  assert.equal(headers['X-Wait-For-Selector'], '#app')
  assert.equal(headers['X-Remove-Selector'], '.ads')
  assert.equal(headers['X-No-Cache'], 'true')
})

test('jina_read: ocr switches the pipeline and steers the page', async () => {
  const { headers } = await headersFor({ url: 'https://example.com/paper.pdf', ocr: true, page: 3, apiKey: 'k' })
  assert.equal(headers['X-Respond-With'], 'jina-ocr-v1')
  assert.equal(headers['X-Page'], '3')
  assert.equal(headers['X-With-Generated-Alt'], undefined,
    'alt generation does not work when X-Respond-With is set')
})

test('jina_read: ocr without a key is refused before any request is spawned', async () => {
  const host = createHost()
  apply(host.ctx)
  const text = await callRead(host, { url: 'https://example.com/paper.pdf', ocr: true })
  assert.match(text, /requires a Jina API key/)
  assert.match(text, /Vision Language Model/)
  assert.equal(host.requests.length, 0, 'a key-gated feature must not spend a doomed request')
})

test('jina_read: the card default turns ocr on, and a per-call false overrides it', async () => {
  const on = await headersFor({ url: 'https://example.com', apiKey: 'k' }, { useOcr: true })
  assert.equal(on.headers['X-Respond-With'], 'jina-ocr-v1')

  const off = await headersFor({ url: 'https://example.com', ocr: false, apiKey: 'k' }, { useOcr: true })
  assert.equal(off.headers['X-Respond-With'], undefined)
})

test('jina_read: alt-text generation is opt-in, key-gated and never rides with ocr', async () => {
  const byDefault = await headersFor({ url: 'https://example.com', apiKey: 'k' })
  assert.equal(byDefault.headers['X-With-Generated-Alt'], undefined,
    'defaulting this on would turn every free anonymous read into a billed one')

  const enabled = await headersFor({ url: 'https://example.com', apiKey: 'k' }, { autoAltText: true })
  assert.equal(enabled.headers['X-With-Generated-Alt'], 'true')

  const noKey = await headersFor({ url: 'https://example.com' }, { autoAltText: true })
  assert.equal(noKey.headers['X-With-Generated-Alt'], undefined, 'the feature is rejected for anonymous callers')

  const withOcr = await headersFor({ url: 'https://example.com', ocr: true, apiKey: 'k' }, { autoAltText: true })
  assert.equal(withOcr.headers['X-With-Generated-Alt'], undefined)
})

test('jina_read: a target selector that matches nothing is retried without the group', async () => {
  const host = createHost({
    responses: [readerBody('tiny'), readerBody('the full article body. '.repeat(30))],
  })
  apply(host.ctx)
  const text = await callRead(host, { url: 'https://example.com' })
  assert.equal(host.requests.length, 2, 'exactly one retry')
  assert.equal(host.requests[0].headers['X-Target-Selector'], DEFAULT_TARGET_SELECTORS)
  assert.equal(host.requests[1].headers['X-Target-Selector'], undefined)
  assert.equal(host.requests[1].headers['X-Remove-Selector'], undefined)
  assert.match(text, /the full article body/)
  assert.ok(!text.includes('tiny'), 'the near-empty first answer must be discarded')
})

test('jina_read: a healthy first answer is not retried', async () => {
  const host = createHost()
  apply(host.ctx)
  await callRead(host, { url: 'https://example.com' })
  assert.equal(host.requests.length, 1)
})

test('jina_read: unwraps the JSON envelope into markdown with the title and usage', async () => {
  const host = createHost()
  apply(host.ctx)
  const text = await callRead(host, { url: 'https://example.com' })
  assert.match(text, /^Title: Example/)
  assert.match(text, /URL Source: https:\/\/example\.com/)
  assert.match(text, /Markdown Content:/)
  assert.match(text, /\[Usage: tokens=42\]/)
})

test('jina_read: an unparsable body is handed back verbatim, never dropped', async () => {
  const host = createHost({ responses: [JSON.stringify({ ok: true, status: 200, text: 'plain markdown, not json' })] })
  apply(host.ctx)
  const text = await callRead(host, { url: 'https://example.com' })
  assert.equal(text, 'plain markdown, not json')
})

test('settings schema: stores only deviations and keeps every reader field', () => {
  const schema = createSettingsSchema()
  assert.deepEqual(schema({}), {})
  assert.deepEqual(schema({ unrelated: true }), {})
  assert.deepEqual(schema({ proxyUrl: 'http://127.0.0.1:7897' }), { proxyUrl: 'http://127.0.0.1:7897' })
  assert.deepEqual(schema({ useOcr: false, autoAltText: false, useSelectors: true }), {},
    'fields left at their default are not materialized into the document')
  assert.deepEqual(schema({ imagePolicy: 'bogus' }), {})
  assert.deepEqual(
    schema({
      useOcr: true, imagePolicy: 'alt', autoAltText: true, useSelectors: false,
      targetSelector: 'article', removeSelector: 'nav', waitForSelector: '#app',
    }),
    {
      useOcr: true, imagePolicy: 'alt', autoAltText: true, useSelectors: false,
      targetSelector: 'article', removeSelector: 'nav', waitForSelector: '#app',
    },
  )
  const dict = createSettingsSchema().toJSON().dict
  for (const field of ['useOcr', 'imagePolicy', 'autoAltText', 'useSelectors', 'targetSelector', 'removeSelector', 'waitForSelector']) {
    assert.ok(dict[field] !== undefined, field + ' must be declared in the schema envelope')
    assert.equal(typeof dict[field].meta, 'object', field + ' needs `meta` for schemastery rehydration')
  }
})

test('toolSettingsOf: an absent or malformed section resolves to the documented defaults', () => {
  assert.deepEqual(toolSettingsOf(undefined), {
    proxyUrl: '',
    useOcr: false,
    imagePolicy: 'all',
    autoAltText: false,
    useSelectors: true,
    targetSelector: '',
    removeSelector: '',
    waitForSelector: '',
  })
  assert.equal(toolSettingsOf('nonsense').imagePolicy, 'all')
  assert.equal(toolSettingsOf({ imagePolicy: 'bogus' }).imagePolicy, 'all')
  assert.equal(toolSettingsOf({ imagePolicy: 'alt' }).imagePolicy, 'alt')
  assert.equal(toolSettingsOf({ useSelectors: false }).useSelectors, false)
  assert.equal(toolSettingsOf({ targetSelector: '  article  ' }).targetSelector, 'article')
})
