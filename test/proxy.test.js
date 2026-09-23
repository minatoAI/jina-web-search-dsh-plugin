/**
 * Unit tests for the manual-proxy policy (proxy.js — pure helpers).
 *
 * Contract under test:
 *   - parseProxyAddress(raw)  : normalize one address into { url, usable, reason }
 *   - proxySettingOf(section) : read `proxyUrl` out of a resolved settings section
 *   - envProxyValue(env)      : first non-empty HTTP(S)/ALL proxy variable
 *   - selectProxy(input)      : precedence request > setting > JINA_PROXY_URL >
 *                               system discovery > inherited environment
 *   - createSettingsSchema()  : the `Config` node the Loader resolves and hands
 *                               to apply(), carrying one volatile ref per field
 *
 * The regression these tests guard: a local proxy that is NOT the Windows
 * system proxy is invisible to WinINET discovery, so the manually configured
 * address must reach the transport ahead of every automatic source.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROXY_ENV_VARS, PROXY_SETTING_FIELD, createSettingsSchema, describeRejectReason,
  envProxyValue, parseProxyAddress, proxySettingOf, selectProxy,
} from '../proxy.js'

const LOCAL = 'http://127.0.0.1:7897'

test('parseProxyAddress: a loopback address with a scheme is usable as-is', () => {
  const r = parseProxyAddress(LOCAL)
  assert.equal(r.usable, true)
  assert.equal(r.url, LOCAL)
})

test('parseProxyAddress: a bare host:port defaults to http', () => {
  const r = parseProxyAddress('127.0.0.1:7897')
  assert.equal(r.usable, true)
  assert.equal(r.url, LOCAL)
})

test('parseProxyAddress: https proxies are usable', () => {
  const r = parseProxyAddress('https://proxy.corp.example:8443')
  assert.equal(r.usable, true)
  assert.equal(r.url, 'https://proxy.corp.example:8443')
})

test('parseProxyAddress: credentials survive normalization', () => {
  const r = parseProxyAddress('http://user:pass@127.0.0.1:7897')
  assert.equal(r.usable, true)
  assert.equal(r.url, 'http://user:pass@127.0.0.1:7897')
})

test('parseProxyAddress: a trailing path is dropped (a proxy address is an origin)', () => {
  const r = parseProxyAddress('http://127.0.0.1:7897/some/path?x=1')
  assert.equal(r.usable, true)
  assert.equal(r.url, LOCAL)
})

test('parseProxyAddress: SOCKS is reported as unusable with the URL kept for display', () => {
  const r = parseProxyAddress('socks5://127.0.0.1:7897')
  assert.equal(r.usable, false)
  assert.equal(r.reason, 'scheme')
  assert.equal(r.url, 'socks5://127.0.0.1:7897')
  assert.match(describeRejectReason(r.reason), /http/)
  assert.match(describeRejectReason('invalid'), /地址/)
  assert.equal(describeRejectReason('unknown-code'), 'unknown-code')
})

test('parseProxyAddress: garbage, empty, and non-string inputs are unusable', () => {
  assert.deepEqual(parseProxyAddress('http://'), { url: '', usable: false, reason: 'invalid' })
  assert.equal(parseProxyAddress('http://[::1').reason, 'invalid')
  assert.deepEqual(parseProxyAddress('   '), { url: '', usable: false, reason: 'empty' })
  assert.equal(parseProxyAddress(undefined).reason, 'empty')
  assert.equal(parseProxyAddress(7897).reason, 'type')
})

test('parseProxyAddress: a bare hostname is accepted (the connect attempt reports the typo)', () => {
  const r = parseProxyAddress('nonsense')
  assert.equal(r.usable, true)
  assert.equal(r.url, 'http://nonsense')
})

test('proxySettingOf: reads the field, ignores other shapes', () => {
  assert.equal(proxySettingOf({ [PROXY_SETTING_FIELD]: LOCAL }), LOCAL)
  assert.equal(proxySettingOf({ [PROXY_SETTING_FIELD]: 7897 }), '')
  assert.equal(proxySettingOf({}), '')
  assert.equal(proxySettingOf(undefined), '')
  assert.equal(proxySettingOf('http://x'), '')
})

test('envProxyValue: reports the first non-empty proxy variable', () => {
  assert.equal(envProxyValue({ HTTPS_PROXY: LOCAL }), LOCAL)
  assert.equal(envProxyValue({ https_proxy: LOCAL }), LOCAL)
  assert.equal(envProxyValue({ HTTP_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' }), 'http://b:2')
  assert.equal(envProxyValue({ http_proxy: '' }), '')
  assert.equal(envProxyValue(undefined), '')
  assert.ok(PROXY_ENV_VARS.includes('ALL_PROXY'))
})

test('selectProxy: the manual setting outranks discovery and the environment', () => {
  const plan = selectProxy({
    setting: LOCAL,
    system: 'http://10.0.0.1:8080',
    env: { HTTPS_PROXY: 'http://10.0.0.2:3128' },
  })
  assert.equal(plan.url, LOCAL)
  assert.equal(plan.source, 'setting')
  assert.deepEqual(plan.rejected, [])
})

test('selectProxy: request override outranks the manual setting', () => {
  const plan = selectProxy({ request: 'http://127.0.0.1:1080', setting: LOCAL })
  assert.equal(plan.url, 'http://127.0.0.1:1080')
  assert.equal(plan.source, 'request')
})

test('selectProxy: JINA_PROXY_URL covers headless profiles without a setting', () => {
  const plan = selectProxy({ envVar: LOCAL, env: {} })
  assert.equal(plan.url, LOCAL)
  assert.equal(plan.source, 'envVar')
})

test('selectProxy: without an explicit address the system proxy wins over the environment', () => {
  const plan = selectProxy({ system: '10.0.0.1:8080', env: { HTTPS_PROXY: 'http://10.0.0.2:3128' } })
  assert.equal(plan.url, 'http://10.0.0.1:8080')
  assert.equal(plan.source, 'system')
})

test('selectProxy: nothing configured anywhere leaves the transport on the inherited environment', () => {
  const inherited = selectProxy({ env: { HTTPS_PROXY: 'http://10.0.0.2:3128' } })
  assert.equal(inherited.url, undefined)
  assert.equal(inherited.source, 'environment')
  assert.equal(inherited.envHint, 'http://10.0.0.2:3128')
  const bare = selectProxy({ env: {} })
  assert.equal(bare.source, 'none')
  assert.equal(bare.envHint, '')
})

test('selectProxy: an unusable configured address is reported and falls through to auto-detection', () => {
  const plan = selectProxy({ setting: 'socks5://127.0.0.1:7897', system: '10.0.0.1:8080', env: {} })
  assert.equal(plan.url, 'http://10.0.0.1:8080')
  assert.equal(plan.source, 'system')
  assert.equal(plan.rejected.length, 1)
  assert.equal(plan.rejected[0].field, 'setting')
  assert.equal(plan.rejected[0].value, 'socks5://127.0.0.1:7897')
  assert.equal(plan.rejected[0].reason, 'scheme')
  assert.equal(plan.rejected[0].message, describeRejectReason('scheme'))
})

test('selectProxy: an unusable setting with no fallback stays visibly rejected', () => {
  const plan = selectProxy({ setting: 'http://', env: {} })
  assert.equal(plan.url, undefined)
  assert.equal(plan.source, 'none')
  assert.equal(plan.rejected[0].reason, 'invalid')
})

test('createSettingsSchema: the Standard Schema envelope the Loader resolves through', () => {
  const schema = createSettingsSchema()
  assert.equal(typeof schema, 'function', 'the node itself is callable')
  assert.equal(schema['~standard'].version, 1)
  assert.equal(schema['~standard'].vendor, 'schemastery', "the Loader's isSchemastery probe reads this")
  const resolved = schema['~standard'].validate({ [PROXY_SETTING_FIELD]: LOCAL }).value
  assert.equal(resolved[PROXY_SETTING_FIELD].get(), LOCAL)
  assert.equal(Object.getPrototypeOf(resolved), Object.prototype, 'volatileEntries only descends into plain objects')
  // A saved field is written into the ref the resolved config holds.
  resolved[PROXY_SETTING_FIELD][Symbol.for('cosmokit.volatile.write')]('http://127.0.0.1:9999')
  assert.equal(resolved[PROXY_SETTING_FIELD].get(), 'http://127.0.0.1:9999')
  // The entry may start with no config at all, and a hand-edited document must
  // never throw inside the shared Plugins settings page.
  for (const raw of [undefined, null, '', 7897, [], 'nonsense', { [PROXY_SETTING_FIELD]: 42 }]) {
    const value = schema['~standard'].validate(raw).value
    assert.equal(Object.getPrototypeOf(value), Object.prototype)
    assert.equal(typeof value[PROXY_SETTING_FIELD].get, 'function')
  }
  assert.equal(schema['~standard'].validate({}).value[PROXY_SETTING_FIELD].get(), undefined,
    'an unset field stays undefined so proxy.js owns the default')
})

test('createSettingsSchema: toJSON is a rehydratable schemastery envelope', () => {
  const json = createSettingsSchema().toJSON()
  assert.equal(json.type, 'object')
  const entry = json.dict[PROXY_SETTING_FIELD]
  assert.equal(entry.type, 'string')
  // schemastery's string resolver dereferences `meta`; a dict entry without it
  // throws "Cannot read properties of undefined (reading 'loose')" once the
  // browser rehydrates the envelope with `new Schema(serialized)`.
  assert.equal(typeof entry.meta, 'object')
  // `meta.volatile` is what makes the field editable without a remount, and
  // `plainSchema()` deletes it off whatever `toJSON()` returns — so every call
  // must hand out fresh nodes instead of the live dict.
  assert.equal(entry.meta.volatile, true)
  assert.notEqual(createSettingsSchema().toJSON().dict[PROXY_SETTING_FIELD], entry)
  assert.equal(createSettingsSchema().toJSON().dict[PROXY_SETTING_FIELD].meta.volatile, true)
})

test('createSettingsSchema: carries the dict/meta surface the settings service walks', () => {
  const schema = createSettingsSchema()
  assert.equal(typeof schema, 'function')
  assert.equal(schema.type, 'object')
  assert.equal(schema.dict[PROXY_SETTING_FIELD].type, 'string')
  assert.equal(typeof schema.meta, 'object')
  assert.equal(schema.dict[PROXY_SETTING_FIELD].meta.volatile, true)
  // A fresh node per plugin instance: two profiles must not share one node.
  assert.notEqual(createSettingsSchema(), createSettingsSchema())
  assert.notEqual(createSettingsSchema().dict[PROXY_SETTING_FIELD], createSettingsSchema().dict[PROXY_SETTING_FIELD])
})
