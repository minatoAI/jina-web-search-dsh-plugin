/**
 * Unit tests for the key-pool policy (keys.js — pure, zero dependencies).
 *
 * The pool exists for one failure mode: an API key whose credits run out (HTTP
 * 402) used to interrupt whatever task was running, because there was nothing
 * to fall back to. These tests pin the arithmetic the host relies on — the
 * reference names the credential seam accepts, the file parsing, the sticky
 * rotation order, the cooldown folding — so a change in the failover behavior
 * has to be deliberate.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KEY_BLOCK_MS, KEY_FAILOVER_STATUSES, KEY_FILE, KEY_REFS, KEY_STATUS,
  clearKeyState, describeKeyStatus, isKeyBlocked, isKeyFailoverStatus,
  keyPoolSignature, keyRotationOrder, keySourceLabel, keyStateAfter,
  keyStatusOf, parseKeyList,
} from '../keys.js'

/** The reference grammar the credentials seam and its Remote controller enforce. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

test('key refs: every slot is a legal credential reference, primary first', () => {
  assert.equal(KEY_REFS[0], 'JINA_API_KEY', 'slot 1 is the reference 0.8.x wrote')
  assert.equal(KEY_REFS.length, 10, 'the card fills these in order as the user keeps adding keys')
  assert.ok(KEY_REFS.length >= 2, 'a pool of one key cannot fail over')
  for (const ref of KEY_REFS) {
    assert.match(ref, REF_PATTERN, ref + ' must satisfy the credentials reference grammar')
  }
  assert.equal(new Set(KEY_REFS).size, KEY_REFS.length, 'refs must be unique')
  // The Remote controller caps one describe batch at 64 references; the card
  // describes every slot at once.
  assert.ok(KEY_REFS.length <= 64)
})

test('key refs: the file fallback keeps its historical name', () => {
  assert.equal(KEY_FILE, 'jina-api-key.txt')
})

test('parseKeyList: one key per line, blanks and comments ignored, duplicates collapsed', () => {
  assert.deepEqual(parseKeyList('k1\nk2\n'), ['k1', 'k2'])
  assert.deepEqual(parseKeyList('  k1  \r\n\r\n# comment\nk2\n'), ['k1', 'k2'])
  assert.deepEqual(parseKeyList('k1\nk1\nk1'), ['k1'], 'the same key twice must be requested once')
  assert.deepEqual(parseKeyList(''), [])
  assert.deepEqual(parseKeyList('   \n\n'), [])
  assert.deepEqual(parseKeyList('single'), ['single'], 'the 0.8.x single-line file still works')
  assert.deepEqual(parseKeyList(undefined), [])
  assert.deepEqual(parseKeyList(42), [])
})

test('isKeyFailoverStatus: only the statuses a key can answer', () => {
  for (const status of KEY_FAILOVER_STATUSES) assert.equal(isKeyFailoverStatus(status), true)
  // 0 is a network/proxy problem and 422 is the caller's arguments: rotating
  // would burn the rest of the pool and hide the real cause.
  for (const status of [0, 200, 201, 400, 403, 404, 422, 500, 503]) {
    assert.equal(isKeyFailoverStatus(status), false, 'HTTP ' + status + ' is not a key problem')
  }
})

test('keyStatusOf / describeKeyStatus: every observed status maps to a label', () => {
  assert.equal(keyStatusOf(200), KEY_STATUS.ok)
  assert.equal(keyStatusOf(401), KEY_STATUS.invalid)
  assert.equal(keyStatusOf(402), KEY_STATUS.quota)
  assert.equal(keyStatusOf(429), KEY_STATUS.rate)
  assert.equal(keyStatusOf(0), KEY_STATUS.offline)
  assert.equal(keyStatusOf(503), KEY_STATUS.error)
  assert.equal(describeKeyStatus(KEY_STATUS.quota, 402), '额度耗尽（HTTP 402）')
  assert.equal(describeKeyStatus(KEY_STATUS.ok, 200), '正常')
  assert.equal(describeKeyStatus(KEY_STATUS.offline, 0), '网络不可达')
  assert.match(describeKeyStatus(KEY_STATUS.error, 503), /503/)
  assert.equal(describeKeyStatus('nonsense', 200), describeKeyStatus(KEY_STATUS.error, 200))
})

test('keyStateAfter: a success clears the key, a failover status parks it', () => {
  const now = 1_000_000
  const healthy = clearKeyState()
  assert.equal(isKeyBlocked(healthy, now), false)

  const quota = keyStateAfter(healthy, 402, now)
  assert.equal(quota.status, KEY_STATUS.quota)
  assert.equal(quota.lastStatus, 402)
  assert.equal(quota.until, now + KEY_BLOCK_MS[402])
  assert.equal(isKeyBlocked(quota, now), true)
  assert.equal(isKeyBlocked(quota, now + KEY_BLOCK_MS[402]), false, 'the cooldown must expire')

  const invalid = keyStateAfter(healthy, 401, now)
  assert.equal(isKeyBlocked(invalid, now + KEY_BLOCK_MS[402]), true, '401 outlasts the 402 cooldown')
  assert.equal(isKeyBlocked(invalid, now + KEY_BLOCK_MS[401] - 1), true)
  assert.equal(isKeyBlocked(invalid, now + KEY_BLOCK_MS[401]), false)

  const rate = keyStateAfter(healthy, 429, now)
  assert.equal(rate.status, KEY_STATUS.rate)
  assert.equal(rate.until, now + KEY_BLOCK_MS[429])

  // A success releases a parked key — that is how a topped-up account returns
  // to the pool.
  assert.equal(isKeyBlocked(keyStateAfter(quota, 200, now), now), false)
  // A non-failover status is not evidence about the key: it must not park it.
  assert.equal(isKeyBlocked(keyStateAfter(healthy, 500, now), now), false)
  assert.equal(keyStateAfter(healthy, 500, now).lastStatus, 200)
  assert.equal(isKeyBlocked(keyStateAfter(undefined, 402, now), now), true, 'an absent state is tolerated')
  assert.equal(isKeyBlocked(undefined, now), false)
})

test('keyRotationOrder: round-robin from the key after the last one used, blocked keys last', () => {
  const now = 1_000_000
  const blocked = keyStateAfter(clearKeyState(), 402, now)
  const healthy = clearKeyState()

  // Nothing tried yet (-1): slot order, starting at key #1.
  assert.deepEqual(keyRotationOrder(3, -1, [healthy, healthy, healthy], now), [0, 1, 2])
  // Round-robin: the walk starts at the key AFTER the one that served the last
  // call, so consecutive calls spread across the pool instead of pinning one key
  // (Jina's rate limits are per key).
  assert.deepEqual(keyRotationOrder(3, 0, [healthy, healthy, healthy], now), [1, 2, 0])
  assert.deepEqual(keyRotationOrder(3, 2, [healthy, healthy, healthy], now), [0, 1, 2])
  // A parked key is demoted, not dropped.
  assert.deepEqual(keyRotationOrder(3, -1, [blocked, healthy, healthy], now), [1, 2])
  assert.deepEqual(keyRotationOrder(3, 1, [blocked, healthy, healthy], now), [2, 1])
  // A whole pool in cooldown is still tried, in rotation order: an exhausted
  // pool must fail honestly instead of the plugin refusing to call the API.
  assert.deepEqual(keyRotationOrder(2, 1, [blocked, blocked], now), [0, 1])
  // Defensive: an empty pool, a stale cursor, and a short state list.
  assert.deepEqual(keyRotationOrder(0, 0, [], now), [])
  assert.deepEqual(keyRotationOrder(2, 7, [healthy, healthy], now), [0, 1])
  assert.deepEqual(keyRotationOrder(2, -1, [healthy, healthy], now), [0, 1])
  assert.deepEqual(keyRotationOrder(2, 0, [], now), [1, 0])
})

test('keyPoolSignature: stable per pool, different when the pool changes', () => {
  const a = keyPoolSignature(['k1', 'k2'])
  assert.equal(a, keyPoolSignature(['k1', 'k2']), 'the same pool must keep its rotation state')
  assert.equal(a, keyPoolSignature([{ value: 'k1' }, { value: 'k2' }]), 'entries and values hash alike')
  assert.notEqual(a, keyPoolSignature(['k1', 'k3']), 'a replaced key must reset the state')
  assert.notEqual(a, keyPoolSignature(['k1', 'k2', 'k3']), 'an appended key must reset the state')
  assert.notEqual(a, keyPoolSignature(['k2', 'k1']), 'a reordered pool is a different pool')
  assert.notEqual(a, keyPoolSignature([]))
  assert.equal(keyPoolSignature(undefined), keyPoolSignature([]))
  // The signature must not reproduce the secret.
  assert.equal(String(a).includes('k1'), false)
})

test('keySourceLabel: every source index.js builds has a label', () => {
  assert.equal(keySourceLabel({ source: 'credential', ref: 'JINA_API_KEY_2' }), '凭据 JINA_API_KEY_2')
  assert.equal(keySourceLabel({ source: 'credential' }), '凭据 JINA_API_KEY')
  assert.equal(keySourceLabel({ source: 'request' }), '调用参数 apiKey')
  assert.equal(keySourceLabel({ source: 'workspace-file', line: 2 }), '工作区 jina-api-key.txt 第 2 行')
  assert.equal(keySourceLabel({ source: 'home-file', line: 1 }), 'dsh 主目录 jina-api-key.txt 第 1 行')
  assert.equal(keySourceLabel(undefined), '未知来源')
  assert.equal(keySourceLabel({}), '未知来源')
})
