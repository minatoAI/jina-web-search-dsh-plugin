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
import { Config, apply } from '../index.js'
import {
  DEFAULT_IMAGE_POLICY, DEFAULT_REMOVE_SELECTORS, DEFAULT_TARGET_SELECTORS,
  READER_BASE, READER_PRESET, READER_TIMEOUT_SECONDS,
  settingsAreLive, settingsSnapshot, toolSettingsOf,
} from '../proxy.js'

/**
 * Resolve one raw stored settings section the way the Loader does before
 * `apply(ctx, config)` — through the plugin's `Config` export.
 */
function resolveSettings(raw) {
  return Config['~standard'].validate(raw === undefined ? {} : raw).value
}

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
      if (key === 'attachments') return options.attachments
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
  return { ctx, requests, tools, settingsValue }
}

/** Invoke `jina_read` the way the tool seam does. */
function callRead(host, args) {
  const tool = host.tools.get('jina_read')
  assert.ok(tool !== undefined, 'jina_read must be registered')
  return tool.execute(args, { agent: { session: { header: { cwd: 'C:\\ws' } } } })
}

/** Invoke `jina_read_pdf` the way the tool seam does. */
function callPdf(host, args) {
  const tool = host.tools.get('jina_read_pdf')
  assert.ok(tool !== undefined, 'jina_read_pdf must be registered')
  return tool.execute(args, { agent: { session: { header: { cwd: 'C:\\ws' } } } })
}

/** Invoke `jina_pdf` the way the tool seam does. */
function callJinaPdf(host, args) {
  const tool = host.tools.get('jina_pdf')
  assert.ok(tool !== undefined, 'jina_pdf must be registered')
  return tool.execute(args, { agent: { session: { header: { cwd: 'C:\\ws' } } } })
}

/** One `extract-pdf` envelope, as the network helper hands it back. */
function pdfBody(floats, meta = {}) {
  return JSON.stringify({
    ok: true,
    status: 200,
    text: JSON.stringify({ floats, meta: { num_pages: 2, num_floats: floats.length, ...meta } }),
  })
}

/** A recording stand-in for the harness attachment store. */
function fakeAttachments(options = {}) {
  const saved = []
  return {
    saved,
    imageLimits: {
      mediaTypes: ['image/png'],
      maxImageBytes: 10 * 1024 * 1024,
      maxImagesPerMessage: 20,
      ...(options.limits || {}),
    },
    async saveImage(input) {
      if (options.fail !== undefined) throw new Error(options.fail)
      saved.push(input)
      return {
        attachmentId: 'att-' + saved.length,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 923,
        height: 842,
        name: input.name,
      }
    },
  }
}

const PNG_B64 = Buffer.from('not-really-a-png').toString('base64')

/** Mount the plugin and return the host plus its first request's headers. */
async function headersFor(args, setting) {
  const host = createHost({ setting })
  apply(host.ctx, resolveSettings(host.settingsValue))
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

test('jina_read: the plain extractor is the only pipeline it ever asks for', async () => {
  // ReaderLM-v2 was removed (0.11.0): measured, it tied the plain extractor on
  // ordinary pages, could not carry the selector group (readerlm-v2 plus a
  // non-matching selector answers 422), and on a long formula-heavy page it
  // echoed the HTML and blew past the transport cap. OCR lives in
  // jina_read_pdf. So jina_read must never set X-Respond-With.
  for (const setting of [{}, { autoAltText: true }, { useSelectors: false }]) {
    const { headers } = await headersFor({ url: 'https://example.com', apiKey: 'k' }, setting)
    assert.equal(headers['X-Respond-With'], undefined)
  }
  const pdf = await headersFor({ url: 'https://example.com/paper.pdf', apiKey: 'k' })
  assert.equal(pdf.headers['X-Respond-With'], undefined,
    'the plain extractor reads PDFs verbatim and ~40x cheaper than OCR')
})

test('jina_read: alt-text generation is opt-in and key-gated', async () => {
  const byDefault = await headersFor({ url: 'https://example.com', apiKey: 'k' })
  assert.equal(byDefault.headers['X-With-Generated-Alt'], undefined,
    'defaulting this on would turn every free anonymous read into a billed one')

  const enabled = await headersFor({ url: 'https://example.com', apiKey: 'k' }, { autoAltText: true })
  assert.equal(enabled.headers['X-With-Generated-Alt'], 'true')

  const noKey = await headersFor({ url: 'https://example.com' }, { autoAltText: true })
  assert.equal(noKey.headers['X-With-Generated-Alt'], undefined, 'the feature is rejected for anonymous callers')
})

test('jina_read: a field saved on the card reaches the next read without a restart', async () => {
  const host = createHost()
  const config = resolveSettings(host.settingsValue)
  apply(host.ctx, config)
  await callRead(host, { url: 'https://example.com', apiKey: 'k' })
  assert.equal(host.requests[0].headers['X-With-Generated-Alt'], undefined)

  // What the settings provider does on save: write into the volatile reference
  // the resolved config holds (the object `apply` captured keeps its identity).
  config.autoAltText[Symbol.for('cosmokit.volatile.write')](true)
  config.useSelectors[Symbol.for('cosmokit.volatile.write')](false)

  await callRead(host, { url: 'https://example.com', apiKey: 'k' })
  assert.equal(host.requests[1].headers['X-With-Generated-Alt'], 'true', 'the saved option must apply to the next call')
  assert.equal(host.requests[1].headers['X-Target-Selector'], undefined, 'and so must turning the selector group off')
  assert.equal(host.requests[1].headers['X-Remove-Selector'], undefined)
})

test('jina_read: a target selector that matches nothing is retried without the group', async () => {
  const host = createHost({
    responses: [readerBody('tiny'), readerBody('the full article body. '.repeat(30))],
  })
  apply(host.ctx, resolveSettings(host.settingsValue))
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
  apply(host.ctx, resolveSettings(host.settingsValue))
  await callRead(host, { url: 'https://example.com' })
  assert.equal(host.requests.length, 1)
})

test('jina_read: unwraps the JSON envelope into markdown with the title and usage', async () => {
  const host = createHost()
  apply(host.ctx, resolveSettings(host.settingsValue))
  const text = await callRead(host, { url: 'https://example.com' })
  assert.match(text, /^Title: Example/)
  assert.match(text, /URL Source: https:\/\/example\.com/)
  assert.match(text, /Markdown Content:/)
  assert.match(text, /\[Usage: tokens=42\]/)
})

test('jina_read: an unparsable body is handed back verbatim, never dropped', async () => {
  const host = createHost({ responses: [JSON.stringify({ ok: true, status: 200, text: 'plain markdown, not json' })] })
  apply(host.ctx, resolveSettings(host.settingsValue))
  const text = await callRead(host, { url: 'https://example.com' })
  assert.equal(text, 'plain markdown, not json')
})

test('jina_read_pdf: OCR is always on and pages are requested one at a time', async () => {
  const host = createHost({ responses: [readerBody('page one'), readerBody('page two')] })
  apply(host.ctx, resolveSettings(host.settingsValue))
  const text = await callPdf(host, { url: 'https://example.com/scan.pdf', pages: '1-2', apiKey: 'k' })
  assert.equal(host.requests.length, 2, 'one request per page: the model transcribes a single page image')
  assert.equal(host.requests[0].headers['X-Respond-With'], 'jina-ocr-v1')
  assert.equal(host.requests[0].headers['X-Page'], '1')
  assert.equal(host.requests[1].headers['X-Page'], '2')
  assert.equal(host.requests[0].headers['X-Target-Selector'], undefined,
    'a CSS selector cannot steer an image-based pipeline')
  assert.match(text, /## Page 1/)
  assert.match(text, /## Page 2/)
  assert.match(text, /\[Reader pipeline: jina-ocr-v1/)
})

test('jina_read_pdf: a page that repeats page 1 ends the walk', async () => {
  // Verified against the live API: an X-Page past the end of the document comes
  // back as page 1 again instead of erroring, so a repeat is the stop signal —
  // without it a page loop would run to maxPages forever.
  const host = createHost({ responses: [readerBody('the only page'), readerBody('the only page')] })
  apply(host.ctx, resolveSettings(host.settingsValue))
  const text = await callPdf(host, { url: 'https://example.com/scan.pdf', pages: '1-5', apiKey: 'k' })
  assert.equal(host.requests.length, 2, 'the walk must stop at the repeat, not keep asking')
  assert.match(text, /stopped because page 2 repeated page 1/)
  assert.ok(!/## Page 2/.test(text), 'the repeated page must not be appended twice')
})

test('jina_read_pdf: a non-PDF URL is refused before any request is spawned', async () => {
  const host = createHost()
  apply(host.ctx, resolveSettings(host.settingsValue))
  const err = await callPdf(host, { url: 'https://example.com/article', apiKey: 'k' }).then(
    () => assert.fail('a web page must not silently go through the document OCR model'),
    (e) => e,
  )
  assert.match(err.message, /does not end in \.pdf/)
  assert.match(err.message, /jina_read/)
  assert.equal(host.requests.length, 0)
})

test('jina_read_pdf: allowNonPdf overrides the URL guard', async () => {
  const host = createHost()
  apply(host.ctx, resolveSettings(host.settingsValue))
  await callPdf(host, { url: 'https://example.com/download?id=7', allowNonPdf: true, pages: '1', apiKey: 'k' })
  assert.equal(host.requests.length, 1)
  assert.equal(host.requests[0].headers['X-Respond-With'], 'jina-ocr-v1')
})

test('jina_read_pdf: without a key it is refused before any request is spawned', async () => {
  const host = createHost()
  apply(host.ctx, resolveSettings(host.settingsValue))
  const err = await callPdf(host, { url: 'https://example.com/scan.pdf' }).then(
    () => assert.fail('a key-gated refusal must throw, not return a successful-looking string'),
    (e) => e,
  )
  assert.match(err.message, /requires a Jina API key/)
  assert.equal(host.requests.length, 0)
})

test('jina_read_pdf: the default range is the first five pages', async () => {
  const host = createHost()
  apply(host.ctx, resolveSettings(host.settingsValue))
  const text = await callPdf(host, { url: 'https://example.com/scan.pdf', apiKey: 'k' })
  assert.equal(host.requests.length, 2, 'the fake answers repeat, so the walk stops at page 2')
  assert.equal(host.requests[0].headers['X-Page'], '1')
  assert.equal(host.requests[1].headers['X-Page'], '2')
  assert.match(text, /jina_read_pdf: 1 page/)
})

test('jina_pdf: the extracted crops are attached as image blocks', async () => {
  // The API returns each detected float as a cropped base64 PNG and nothing
  // else — no markdown, no LaTeX, a placeholder caption — so dropping the
  // images would leave a useless inventory.
  const attachments = fakeAttachments()
  const host = createHost({
    attachments,
    responses: [pdfBody([
      { type: 'table', number: '1', caption: 'Table (detected)', page: 4, image: PNG_B64, width: 923, height: 842 },
      { type: 'figure', number: '2', caption: 'Figure (detected)', page: 5, image: PNG_B64, width: 100, height: 200 },
    ])],
  })
  apply(host.ctx, resolveSettings(host.settingsValue))
  const value = await callJinaPdf(host, { arxivId: '2601.21337', apiKey: 'k' })

  assert.equal(attachments.saved.length, 2, 'every crop must reach the attachment store')
  assert.equal(attachments.saved[0].mediaType, 'image/png')
  assert.equal(attachments.saved[0].name, 'jina-pdf-table-1-page4.png')
  assert.ok(attachments.saved[0].data.length > 0, 'the base64 must be decoded to bytes')

  const images = value.blocks.filter((block) => block.type === 'image')
  assert.equal(images.length, 2, 'one image block per attached crop')
  assert.equal(images[0].attachment.attachmentId, 'att-1')
  assert.equal(images[1].attachment.width, 923)
  assert.match(value.blocks[0].text, /Extracted items: 2/)
  assert.match(value.blocks[0].text, /\[table 1\] page 4, 923x842 px/)
  assert.match(value.blocks[0].text, /2 extracted image\(s\) are attached below/)
})

test('jina_pdf: without an attachment store the inventory still comes back, with a note', async () => {
  const host = createHost({ responses: [pdfBody([{ type: 'table', number: '1', page: 4, image: PNG_B64 }])] })
  apply(host.ctx, resolveSettings(host.settingsValue))
  const value = await callJinaPdf(host, { arxivId: '1', apiKey: 'k' })
  assert.equal(value.blocks.filter((block) => block.type === 'image').length, 0)
  assert.match(value.blocks[0].text, /Extracted items: 1/)
  assert.match(value.blocks[0].text, /no attachment store/)
})

test('jina_pdf: maxImages caps the attachments and says what was left out', async () => {
  const attachments = fakeAttachments()
  const floats = Array.from({ length: 4 }, (_, i) => ({ type: 'table', number: String(i + 1), page: i + 1, image: PNG_B64 }))
  const host = createHost({ attachments, responses: [pdfBody(floats)] })
  apply(host.ctx, resolveSettings(host.settingsValue))
  const value = await callJinaPdf(host, { arxivId: '1', maxImages: 2, apiKey: 'k' })
  assert.equal(value.blocks.filter((block) => block.type === 'image').length, 2)
  assert.match(value.blocks[0].text, /only the first 2 image\(s\) were attached/)
})

test('jina_pdf: an image the store refuses is reported, never thrown', async () => {
  const attachments = fakeAttachments({ fail: 'the image exceeds the deployment limits' })
  const host = createHost({ attachments, responses: [pdfBody([{ type: 'table', number: '1', page: 1, image: PNG_B64 }])] })
  apply(host.ctx, resolveSettings(host.settingsValue))
  const value = await callJinaPdf(host, { arxivId: '1', apiKey: 'k' })
  assert.equal(value.blocks.filter((block) => block.type === 'image').length, 0)
  assert.match(value.blocks[0].text, /Extracted items: 1/, 'one oversized figure must not lose the extraction')
  assert.match(value.blocks[0].text, /exceeds the deployment limits/)
})

test('settings schema: every reader field is declared as a live (volatile) field', () => {
  // The entry id `jina-tools` *is* the settings namespace; this export is what
  // the settings provider serves. A field is editable without a restart only
  // when its node carries `meta.volatile` — the provider derives the form from
  // exactly that flag, and `write()` rejects any path that lacks it.
  const fields = [
    'proxyUrl', 'imagePolicy', 'autoAltText', 'useSelectors',
    'targetSelector', 'removeSelector', 'waitForSelector',
  ]
  const dict = Config.toJSON().dict
  for (const field of fields) {
    assert.ok(Config.dict[field] !== undefined, field + ' must be declared in the schema dict')
    assert.equal(Config.dict[field].meta.volatile, true, field + ' must be volatile, or saving it would remount the plugin')
    assert.ok(dict[field] !== undefined, field + ' must survive toJSON()')
    assert.equal(dict[field].meta.volatile, true, field + ' must keep meta.volatile through toJSON()')
    assert.equal(typeof dict[field].meta, 'object', field + ' needs `meta` for schemastery rehydration')
    assert.equal(dict[field].type, Config.dict[field].type)
  }
  assert.equal(dict.proxyUrl.type, 'string')
  assert.equal(dict.imagePolicy.type, 'string')
  // A fresh envelope per call: `plainSchema()` walks the result and deletes
  // `meta.volatile`, so a shared dict would silently disable live editing for
  // every later save.
  assert.notEqual(Config.toJSON().dict.proxyUrl, Config.toJSON().dict.proxyUrl)
  assert.equal(Config.toJSON().dict.proxyUrl.meta.volatile, true)
})

test('settings schema: resolve() hands back the volatile refs the harness writes into', () => {
  const resolved = resolveSettings({ proxyUrl: 'http://127.0.0.1:7897', useSelectors: false })
  assert.equal(settingsAreLive(resolved), true)
  // `settingsSnapshot` reads through the refs, so a write by the settings
  // provider is visible to the very next operation — no restart.
  assert.equal(settingsSnapshot(resolved).proxyUrl, 'http://127.0.0.1:7897')
  assert.equal(settingsSnapshot(resolved).useSelectors, false)
  const write = Symbol.for('cosmokit.volatile.write')
  resolved.useSelectors[write](true)
  assert.equal(settingsSnapshot(resolved).useSelectors, true, 'a saved field must reach the running plugin in place')
  // A malformed / absent stored section must not throw: the entry may start
  // with no config at all.
  assert.equal(settingsAreLive(resolveSettings(undefined)), true)
  assert.equal(settingsSnapshot(resolveSettings('nonsense')).proxyUrl, undefined)
  assert.equal(settingsSnapshot(undefined).proxyUrl, undefined)
  assert.equal(settingsAreLive(undefined), false)
})

test('settings schema: unset fields mean "default", and toolSettingsOf owns the defaults', () => {
  const section = settingsSnapshot(resolveSettings({}))
  assert.equal(section.imagePolicy, undefined)
  assert.equal(section.useSelectors, undefined)
  const defaults = toolSettingsOf(section)
  assert.equal(defaults.imagePolicy, 'all')
  assert.equal(defaults.autoAltText, false)
  assert.equal(defaults.useSelectors, true, 'the selector group is on unless it is explicitly turned off')
  assert.equal(defaults.proxyUrl, '')
})

test('toolSettingsOf: an absent or malformed section resolves to the documented defaults', () => {
  assert.deepEqual(toolSettingsOf(undefined), {
    proxyUrl: '',
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
