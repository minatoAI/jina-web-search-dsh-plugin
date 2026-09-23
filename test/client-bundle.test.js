/**
 * Contract tests for the browser bundle (ui/client.js).
 *
 * The bundle is committed prebuilt — there is no build step — so a hand edit
 * is what ships. These tests parse it (a syntax error would otherwise only
 * surface as "Failed to load plugins" in the running Web UI) and pin the
 * registration facts the module system and the settings tab depend on:
 *
 *   - `window.__ModuleLoader__.load({ id: 'dsh-jina' })` — the id MUST equal
 *     the graph row id (the exact package name); anything else makes the module
 *     system report `loaded without registering "dsh-jina"` and the whole page
 *     fails to load its plugins.
 *   - the configuration form registers into the Plugins page's
 *     `plugins.bundle.config` slot, keyed by the bundle's package name
 *     (`dsh-jina`) — the surface current harnesses declare — and into the
 *     older `settings.plugin.item` slot, keyed by the settings namespace the
 *     host half serves (`jina-tools`), so one bundle configures on either.
 *   - the manual proxy field (`proxyUrl`) rides the standard `remote.settings`
 *     transport (`describe` / `mutate`), and external edits arrive through
 *     `settings/document-updated`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { KEY_REFS } from '../keys.js'

const SOURCE = await readFile(new URL('../ui/client.js', import.meta.url), 'utf8')

test('client bundle: parses as a script (no build step to catch typos)', () => {
  assert.doesNotThrow(() => new Script(SOURCE, { filename: 'ui/client.js' }))
})

test('client bundle: registers under the graph row id (exact package name)', () => {
  assert.match(SOURCE, /__ModuleLoader__\.load\(/)
  assert.match(SOURCE, /id:\s*'dsh-jina'/)
  assert.doesNotMatch(SOURCE, /id:\s*'dsh-jina\/ui'/)
})

test('client bundle: configures through the Plugins page bundle slot', () => {
  // The Plugins page declares `plugins.bundle.config` keyed by the bundle's
  // package name; it draws the card's title, icon, and crumb itself and asks
  // the entry for two views: `summary` (the one-liner under the title) and
  // `page` (the form with its own save control).
  assert.match(SOURCE, /name:\s*'plugins\.bundle\.config'/)
  assert.match(SOURCE, /key:\s*'dsh-jina'/)
  assert.match(SOURCE, /props\.view === 'summary'/)
  assert.match(SOURCE, /props\.view === 'page'/)
})

test('client bundle: still registers the legacy settings card for older harnesses', () => {
  assert.match(SOURCE, /name:\s*'settings\.plugin\.item'/)
  assert.match(SOURCE, /key:\s*'jina-tools'/)
  assert.match(SOURCE, /NS\s*=\s*'jina-tools'/)
})

test('client bundle: injects the credentials and remote planes it consumes', () => {
  assert.match(SOURCE, /exports\.inject\s*=\s*\[[^\]]*'slots'[^\]]*'remote'[^\]]*'remote\.credentials'/)
})

test('client bundle: declares every Remote namespace service it reads', () => {
  // Regression: the gateway mounts each Remote namespace as its own cordis
  // service, so `remote.settings` throws `cannot get property
  // "remote.settings" without inject` from the property access itself unless
  // the consumer lists it. 0.6.0 shipped without it and the thrown error
  // crashed the settings slot entry ("slot entry crashed in
  // 'settings.plugin.item'"), so the whole card disappeared.
  const declared = /exports\.inject\s*=\s*\[([^\]]*)\]/.exec(SOURCE)
  assert.ok(declared, 'exports.inject must be declared')
  const names = declared[1].split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter((part) => part !== '')
  assert.deepEqual(names, ['slots', 'remote', 'remote.credentials', 'remote.settings'])
  for (const nested of ['remote.credentials', 'remote.settings']) {
    assert.ok(names.includes(nested), nested + ' must be declared because the card reads it off `remote`')
  }
})

test('client bundle: the settings face is read defensively, never crashing a slot', () => {
  assert.match(SOURCE, /var settingsApi = function \(\) \{/)
  assert.match(SOURCE, /try \{\s*return remote && remote\.settings/)
  assert.match(SOURCE, /catch \(err\) \{\s*return undefined\s*\}/)
})

test('client bundle: the manual proxy rides the settings Remote namespace', () => {
  assert.match(SOURCE, /PROXY_FIELD\s*=\s*'proxyUrl'/)
  assert.match(SOURCE, /remote\.settings/)
  assert.match(SOURCE, /\.describe\(\)/)
  assert.match(SOURCE, /\.mutate\(/)
  assert.match(SOURCE, /settings\/document-updated/)
})

test('client bundle: proxy writes are fenced by the revision the card read', () => {
  assert.match(SOURCE, /mutate\(NS,\s*ops,\s*proxyView\.revision\)/)
})

test('client bundle: the card shows the proxy the probe actually used', () => {
  assert.match(SOURCE, /JINA_PROXY_URL/)
  assert.match(SOURCE, /本次检测所用代理/)
  assert.match(SOURCE, /proxyConfigured/)
})

test('client bundle: a non-http(s) address is refused before it can be saved', () => {
  assert.match(SOURCE, /只支持 http:\/\/ 或 https:\/\/ 代理/)
})

test('client bundle: the reader options ride the same namespace and write path', () => {
  // The bundle is hand-edited, so a dropped field would silently make the
  // control a no-op: the card would render a checkbox that writes nothing.
  for (const field of ['useReaderLm', 'imagePolicy', 'autoAltText', 'useSelectors', 'targetSelector', 'removeSelector']) {
    assert.match(SOURCE, new RegExp("'" + field + "'"), field + ' must be wired into the card')
  }
  assert.match(SOURCE, /readerlm-v2/, 'the switch must name the model it turns on')
  assert.match(SOURCE, /3× token/, 'the cost must be stated where the switch is')
  assert.match(SOURCE, /jina_read_pdf/, 'the switch must point PDFs at the tool that owns OCR')
  assert.doesNotMatch(SOURCE, /useOcr/, 'the retired OCR field must not be written any more')
  // One writer, revision-fenced: the options must not grow a second mutate path.
  const mutations = SOURCE.match(/\.mutate\(/g) || []
  assert.equal(mutations.length, 1, 'exactly one settings write path')
  assert.match(SOURCE, /mutate\(NS,\s*ops,\s*proxyView\.revision\)/)
})

test('client bundle: the key pool is the same reference list the host resolves', () => {
  // The credentials namespace has no enumeration, so the card must name the
  // references itself — and a drift from keys.js would leave a slot the host
  // never reads, or a key the card cannot save.
  const declared = /var KEY_REFS = \[([^\]]*)\]/.exec(SOURCE)
  assert.ok(declared, 'the bundle must declare the key pool')
  const refs = declared[1].split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter((part) => part !== '')
  assert.deepEqual(refs, KEY_REFS)
  assert.match(SOURCE, /credentials\.describe\(KEY_REFS\)/, 'the card describes the whole pool in one batch')
})

test('client bundle: one input adds to the first free slot, and nothing is removable by hand', () => {
  // The single-input form is the whole point: a regression here would bring back
  // one input per slot, or a per-key list the user has to manage.
  assert.match(SOURCE, /var \[keyDraft, setKeyDraft\] = React\.useState\(''\)/, 'one draft, not a map of drafts')
  assert.match(SOURCE, /function firstFreeRef\(\)/)
  assert.match(SOURCE, /credentials\.set\(ref, value\)/)
  assert.match(SOURCE, /KEY_REFS\.indexOf\(ref\)/, 'a reference-updated event for any slot must refresh the card')
  // The host discards a dead key; the page must never offer a remove control.
  assert.equal(/credentials\.unset\(/.test(SOURCE), false, 'the card must not delete keys itself')
  assert.equal(/移除/.test(SOURCE), false, 'no remove control anywhere')
})

test('client bundle: the health section reports the key count and one total, nothing per key', () => {
  assert.match(SOURCE, /keyCount/)
  assert.match(SOURCE, /balanceTotal/)
  assert.match(SOURCE, /Key 总数：/)
  assert.match(SOURCE, /总余额：/)
  assert.match(SOURCE, /discardedCount/)
  // No per-key detail, and no usable/total split, may be rendered or even read
  // from the payload.
  assert.equal(/usableCount/.test(SOURCE), false, 'the page shows only the pool size')
  assert.equal(/\.keys\b/.test(SOURCE), false, 'the payload carries no per-key array to render')
  assert.equal(/statusLabel/.test(SOURCE), false, 'no per-key status label')
  assert.equal(/authenticatedAs/.test(SOURCE), false, 'no identity line')
})

test('client bundle: the pool copy names the failover and auto-discard contract', () => {
  assert.match(SOURCE, /额度耗尽自动丢弃/)
  assert.match(SOURCE, /401/)
  assert.match(SOURCE, /402/)
  assert.match(SOURCE, /429/)
})
