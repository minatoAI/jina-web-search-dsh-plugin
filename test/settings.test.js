/**
 * Unit tests for the endpoint policy (settings.js — pure helpers).
 *
 * What is pinned here:
 *   - `endpointModeOf(section)`  : a stored mode is validated, anything else is `auto`
 *   - `routePlan(mode, kind, preferred)` : which host pair a call tries, in order
 *   - `cnBypassEnv(inherited)`   : the NO_PROXY overlay the CN route rides
 *
 * The regression these tests guard: Jina's global hosts are DNS-poisoned and
 * blackholed from mainland China, and the vendor's official mainland mirrors
 * (`r.jinaai.cn` / `s.jinaai.cn`) are the replacement domain. The plugin needs
 * no proxy at all — but it must never point a CN request at Jina's global hosts,
 * and it must never let an inherited proxy capture a domestic CDN address.
 *
 * The schema/defaults half of the same module is covered by
 * test/reader-headers.test.js, which drives the real `Config` export.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CN_NO_PROXY, DEFAULT_ENDPOINT_MODE, ENDPOINT_FIELD, ENDPOINT_HOSTS, ENDPOINT_MODES,
  cnBypassEnv, endpointModeOf, routePlan,
} from '../settings.js'

test('the endpoint table names the vendor\'s official hosts on both sides', () => {
  assert.deepEqual(ENDPOINT_MODES, ['auto', 'global', 'cn'])
  assert.equal(DEFAULT_ENDPOINT_MODE, 'auto')
  assert.equal(ENDPOINT_FIELD, 'endpoint')
  // The reader family.
  assert.equal(ENDPOINT_HOSTS.reader.global, 'https://r.jina.ai/')
  assert.equal(ENDPOINT_HOSTS.reader.cn, 'https://r.jinaai.cn/')
  // The search family is `s.jina.ai`, NOT the `svip.jina.ai` host this plugin
  // used before: the documented endpoint has a mainland mirror and answers the
  // same `{ code, status, data: [...] }` shape, so one formatter covers both.
  assert.equal(ENDPOINT_HOSTS.search.global, 'https://s.jina.ai/')
  assert.equal(ENDPOINT_HOSTS.search.cn, 'https://s.jinaai.cn/')
  assert.equal(CN_NO_PROXY, 'jinaai.cn')
})

test('endpointModeOf: reads the field, validates it, defaults to auto', () => {
  assert.equal(endpointModeOf({ [ENDPOINT_FIELD]: 'cn' }), 'cn')
  assert.equal(endpointModeOf({ [ENDPOINT_FIELD]: 'global' }), 'global')
  assert.equal(endpointModeOf({ [ENDPOINT_FIELD]: 'auto' }), 'auto')
  // A hand-edited or unknown value must not select a host by accident.
  assert.equal(endpointModeOf({ [ENDPOINT_FIELD]: 'bogus' }), 'auto')
  assert.equal(endpointModeOf({ [ENDPOINT_FIELD]: 42 }), 'auto')
  assert.equal(endpointModeOf({ [ENDPOINT_FIELD]: null }), 'auto')
  assert.equal(endpointModeOf({}), 'auto')
  assert.equal(endpointModeOf(undefined), 'auto')
  assert.equal(endpointModeOf('cn'), 'auto')
})

test('routePlan: a pinned mode yields exactly one candidate', () => {
  assert.deepEqual(routePlan('cn', 'reader', 'global'), [{ side: 'cn', base: 'https://r.jinaai.cn/' }])
  assert.deepEqual(routePlan('global', 'reader', 'cn'), [{ side: 'global', base: 'https://r.jina.ai/' }])
  // Pinning is an instruction, not a hint: a failure must be reported, never
  // papered over by the other side.
  assert.equal(routePlan('cn', 'search', 'global').length, 1)
  assert.equal(routePlan('global', 'search', 'cn').length, 1)
})

test('routePlan: auto tries the side that answered last, then the other one', () => {
  assert.deepEqual(routePlan('auto', 'reader', 'global'), [
    { side: 'global', base: 'https://r.jina.ai/' },
    { side: 'cn', base: 'https://r.jinaai.cn/' },
  ])
  assert.deepEqual(routePlan('auto', 'reader', 'cn'), [
    { side: 'cn', base: 'https://r.jinaai.cn/' },
    { side: 'global', base: 'https://r.jina.ai/' },
  ])
  // An unknown preference is treated as "nothing has answered yet".
  assert.equal(routePlan('auto', 'reader', undefined)[0].side, 'global')
  assert.equal(routePlan('auto', 'reader', 'nonsense')[0].side, 'global')
})

test('routePlan: the plan follows the API family', () => {
  assert.deepEqual(routePlan('auto', 'search', 'global').map((r) => r.base), ['https://s.jina.ai/', 'https://s.jinaai.cn/'])
  assert.deepEqual(routePlan('auto', 'search', 'cn').map((r) => r.base), ['https://s.jinaai.cn/', 'https://s.jina.ai/'])
  // An unknown kind must not produce `undefined` URLs — it reads as `reader`.
  assert.deepEqual(routePlan('auto', 'nonsense', 'global').map((r) => r.base), ['https://r.jina.ai/', 'https://r.jinaai.cn/'])
})

test('routePlan: every plan is at most two attempts, and never the same host twice', () => {
  for (const mode of ENDPOINT_MODES) {
    for (const kind of ['reader', 'search']) {
      for (const preferred of ['global', 'cn', undefined]) {
        const plan = routePlan(mode, kind, preferred)
        assert.ok(plan.length <= 2, mode + '/' + kind + ' must not fan out')
        assert.equal(new Set(plan.map((r) => r.base)).size, plan.length, 'no host may be tried twice in one call')
      }
    }
  }
})

test('cnBypassEnv: the CN suffix is added to the inherited list, never replacing it', () => {
  // The harness resolves its own outbound policy from the launching environment;
  // a CN host is a domestic CDN address and must not ride that proxy.
  assert.deepEqual(cnBypassEnv(''), { NO_PROXY: CN_NO_PROXY, no_proxy: CN_NO_PROXY })
  assert.deepEqual(cnBypassEnv(undefined), { NO_PROXY: CN_NO_PROXY, no_proxy: CN_NO_PROXY })
  assert.deepEqual(cnBypassEnv(null), { NO_PROXY: CN_NO_PROXY, no_proxy: CN_NO_PROXY })
  assert.deepEqual(cnBypassEnv(42), { NO_PROXY: CN_NO_PROXY, no_proxy: CN_NO_PROXY })
  assert.deepEqual(cnBypassEnv('localhost,127.0.0.1'), { NO_PROXY: 'localhost,127.0.0.1,' + CN_NO_PROXY, no_proxy: 'localhost,127.0.0.1,' + CN_NO_PROXY })
  assert.deepEqual(cnBypassEnv('  localhost  '), { NO_PROXY: 'localhost,' + CN_NO_PROXY, no_proxy: 'localhost,' + CN_NO_PROXY })
  // Both casings are written because Windows tooling and Node differ.
  const env = cnBypassEnv('')
  assert.equal(env.NO_PROXY, env.no_proxy)
})

test('cnBypassEnv: an inherited list that already carries the suffix is left alone', () => {
  assert.deepEqual(cnBypassEnv(CN_NO_PROXY), { NO_PROXY: CN_NO_PROXY, no_proxy: CN_NO_PROXY })
  assert.deepEqual(cnBypassEnv('localhost,' + CN_NO_PROXY), { NO_PROXY: 'localhost,' + CN_NO_PROXY, no_proxy: 'localhost,' + CN_NO_PROXY })
  assert.deepEqual(cnBypassEnv('localhost, ' + CN_NO_PROXY + ' ,127.0.0.1'), { NO_PROXY: 'localhost, ' + CN_NO_PROXY + ' ,127.0.0.1', no_proxy: 'localhost, ' + CN_NO_PROXY + ' ,127.0.0.1' })
})
