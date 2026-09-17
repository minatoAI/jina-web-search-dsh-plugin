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
