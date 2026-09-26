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
 *   - the endpoint field (`endpoint`) rides the standard `remote.settings`
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

test('client bundle: the endpoint mode rides the settings Remote namespace', () => {
  assert.match(SOURCE, /ENDPOINT_FIELD\s*=\s*'endpoint'/)
  assert.match(SOURCE, /remote\.settings/)
  assert.match(SOURCE, /\.describe\(\)/)
  assert.match(SOURCE, /\.mutate\(/)
  assert.match(SOURCE, /settings\/document-updated/)
})

test('client bundle: endpoint writes are fenced by the revision the card read', () => {
  assert.match(SOURCE, /mutate\(NS,\s*ops,\s*nsView\.revision\)/)
})

test('client bundle: the card shows the endpoint side the probe actually used', () => {
  assert.match(SOURCE, /本次检测所用接口域名/)
  assert.match(SOURCE, /ENDPOINT_SIDES/)
  assert.match(SOURCE, /primer\.data\.endpoint/)
})

test('client bundle: the card offers exactly the three endpoint modes', () => {
  // A missing option would make a mode unreachable from the UI; an extra one
  // would be a value the host rejects.
  const modes = /var ENDPOINT_MODES = \[([^\]]*)\]/.exec(SOURCE)
  assert.ok(modes, 'the bundle must declare the endpoint modes')
  const names = modes[1].split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter((part) => part !== '')
  assert.deepEqual(names, ['auto', 'global', 'cn'])
  assert.match(SOURCE, /r\.jinaai\.cn/)
  assert.match(SOURCE, /s\.jinaai\.cn/)
  // The proxy machinery is gone: no proxy field, no proxy copy.
  assert.equal(/proxyUrl/.test(SOURCE), false, 'the retired proxy field must not be written any more')
  assert.equal(/JINA_PROXY_URL/.test(SOURCE), false, 'the retired proxy env var must not be referenced')
})

test('client bundle: the connection hint does not advise a proxy the plugin no longer has', () => {
  // The proxy machinery went in 0.12.0 (settings.js: the endpoint policy "never
  // touches a proxy"), but the connection-failure hint kept telling users to
  // check a 本地代理 address/port and a proxy field that no longer exist. It now
  // names the endpoints and the one proxy fact that is still true — an inherited
  // HTTP_PROXY carries the global hosts, while the CN attempt bypasses it.
  assert.match(SOURCE, /接口域名」改成「自动」或「国际」/, 'the hint offers the reachable modes')
  assert.match(SOURCE, /HTTP_PROXY \/ HTTPS_PROXY/, 'and names the inherited proxy honestly')
  assert.match(SOURCE, /国内域名会自动绕过/, 'including which side bypasses it')
  assert.equal(/本地代理/.test(SOURCE), false, 'the retired proxy-address hint must stay gone')
  assert.equal(/填写的地址\/端口/.test(SOURCE), false, 'nor its address/port wording')
  assert.equal(/本地代理正在运行/.test(SOURCE), false, 'nor its "is the proxy running" advice')
})

test('client bundle: the reader options ride the same namespace and write path', () => {
  // The bundle is hand-edited, so a dropped field would silently make the
  // control a no-op: the card would render a checkbox that writes nothing.
  for (const field of ['imagePolicy', 'autoAltText', 'useSelectors', 'targetSelector', 'removeSelector']) {
    assert.match(SOURCE, new RegExp("'" + field + "'"), field + ' must be wired into the card')
  }
  assert.doesNotMatch(SOURCE, /useOcr/, 'the retired OCR field must not be written any more')
  assert.doesNotMatch(SOURCE, /useReaderLm/, 'the retired ReaderLM field must not be written any more')
  assert.doesNotMatch(SOURCE, /readerlm/, 'the card must not offer the removed ReaderLM pipeline')
  // One writer, revision-fenced: the options must not grow a second mutate path.
  const mutations = SOURCE.match(/\.mutate\(/g) || []
  assert.equal(mutations.length, 1, 'exactly one settings write path')
  assert.match(SOURCE, /mutate\(NS,\s*ops,\s*nsView\.revision\)/)
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

test('client bundle: the low-balance reminder rides the shell overlay slot', () => {
  // The seat is a plain root-scope LIST slot: the shell renders every registered
  // id, so this is an ordinary plugin entry — no harness change, no allowlist.
  // A renamed id would leave the notice registered but never drawn, and a
  // renamed slot would leave it unregistered entirely.
  assert.match(SOURCE, /name:\s*'shell\.overlay'/)
  assert.match(SOURCE, /id:\s*'jina\.balance'/)
  assert.match(SOURCE, /ctx\.slots\.inject\('shell\.overlay'/)
})

test('client bundle: the reminder is titled, names the threshold, and shows the live balance', () => {
  // The number is load-bearing in both directions: a typo'd order of magnitude
  // either never fires or fires on a healthy pool.
  const threshold = /LOW_BALANCE_THRESHOLD\s*=\s*([0-9_]+)/.exec(SOURCE)
  assert.ok(threshold, 'the bundle must declare the reminder threshold')
  assert.equal(Number(threshold[1].replace(/_/g, '')), 1000000)
  assert.match(SOURCE, /balanceTotal/, 'the reminder reads the pool total the host reports')
  assert.match(SOURCE, /'Jina Tools'/, 'the notice is titled with the plugin name')
  assert.match(SOURCE, /该插件可用点数少于 /, 'the body names the threshold it crossed')
  assert.match(SOURCE, /请注意补充/, 'and asks the user to top up')
  assert.match(SOURCE, /当前还有 /, 'the next line states the balance it is actually at')
  assert.match(SOURCE, /'知道了'/, 'and one action dismisses the notice')
  // The old billing link must not come back.
  assert.equal(/去充值/.test(SOURCE), false, 'the billing link must stay gone')
})

test('client bundle: the settings jump stays gone', () => {
  // It was tried and dropped: DSH exposes no open-settings API to a plugin
  // (`openSettings` is owner props for the SINGLE `settings.launcher` seat,
  // already owned by the account menu, and the panel has no URL route), so it
  // had to drive the shell's DOM through `aria-haspopup` / `nav button` /
  // 插件|plugins — and it behaved unreliably in practice. Nothing may quietly
  // reintroduce that coupling.
  assert.equal(/打开设置/.test(SOURCE), false, 'the settings button must not come back')
  assert.equal(/aria-haspopup/.test(SOURCE), false, 'nor the DOM hook it used')
  assert.equal(/data-shortcut-modal/.test(SOURCE), false, 'nor the panel locator')
  assert.equal(/openPluginSettings/.test(SOURCE), false, 'nor the function itself')
})

test('client bundle: the reminder owns the glow and the two-flash pulse', () => {
  // The border glow is the reason this bundle injects a <style>: keyframes
  // cannot be expressed in an inline style. A rename anywhere here leaves the
  // notice static — the exact state the user rejected.
  assert.match(SOURCE, /@keyframes dsh-jina-low-balance-flash/)
  assert.match(SOURCE, /animation: 'dsh-jina-low-balance-flash 1\.1s ease-in-out 2'/, 'two flashes, then settle')
  assert.match(SOURCE, /LOW_BALANCE_STYLE_ID/, 'the stylesheet is injected under a stable id')
  assert.match(SOURCE, /document\.getElementById\(LOW_BALANCE_STYLE_ID\)/, 'and injected only once per page')
  assert.match(SOURCE, /prefers-reduced-motion/, 'a reduced-motion profile must not be flashed at')
  assert.match(SOURCE, /boxShadow: '0 0 0 1px rgba\(224,49,49/, 'the steady glow is inline, so it survives a missing document')
})

test('client bundle: the threshold can be overridden for a live demonstration', () => {
  // The README documents this as the manual trigger ("set a number above the
  // pool total, reload"); a rename here would silently break those steps while
  // every other test kept passing.
  assert.match(SOURCE, /LOW_BALANCE_THRESHOLD_KEY\s*=\s*'dsh-jina:low-balance-threshold'/)
  assert.match(SOURCE, /function effectiveThreshold\(\)/)
})
