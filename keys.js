/**
 * dsh-jina — API key pool policy (pure helpers, zero dependencies).
 *
 * One key is a single point of failure: when its credits run out (HTTP 402),
 * the vendor rate-limits it (429) or the key is revoked (401), every later
 * tool call fails and a task is interrupted mid-flight. This module owns the
 * pool that fixes that — the references the card writes, the parsing of the
 * multi-line key file, and the rotation/cooldown arithmetic the host applies
 * while walking the pool — so all of it is unit-testable without a harness
 * (see test/keys.test.js).
 *
 * Pool sources, in the order index.js resolves them (first source that yields
 * at least one key wins; within a source every key joins the rotation):
 *   1. the tool's own `apiKey` parameter (a single key, never rotated),
 *   2. the credential references below, in slot order,
 *   3. `jina-api-key.txt` in the calling session's workspace,
 *   4. `jina-api-key.txt` in the dsh home directory.
 *
 * The credential seam stores one value per reference and never reads one back
 * (its `describe` view carries `configured`/`source`/`writable` only), so
 * "several keys" is several references — one per slot, which the card fills in
 * order as the user keeps adding keys. The references are plain POSIX
 * identifiers, which is exactly the grammar the credentials seam and its Remote
 * controller both enforce, so no harness change is needed.
 *
 * Rotation is sticky: the key that served the last successful call is tried
 * first again, so a healthy pool never pays for a failing key. A key that just
 * failed with a failover status is skipped until its cooldown expires (401 is
 * effectively permanent until the pool changes, because the same stored value
 * cannot start working again; 402 may heal the moment the account is topped
 * up; 429 is transient). When every key is cooling down the rotation order is
 * used as-is rather than refusing to try: an honest failure is better than a
 * plugin that stops calling the API.
 *
 * A key that is *definitively* unusable is not merely skipped — index.js deletes
 * its credential (`credentials.unset`), so the pool stays clean without the user
 * managing anything: 401 (revoked), 402 (quota exhausted) and a probe reporting
 * a balance of zero all discard the slot. 429 does not: a rate limit is
 * temporary, and discarding a working key over it would be wrong. The cooldown
 * machinery above is what covers the cases a delete cannot fix (a key supplied
 * read-only by the environment, a key that came from a file the plugin will not
 * rewrite).
 */

/**
 * The credential references the card writes and the host resolves, in slot
 * order. `JINA_API_KEY` is the reference the single-key card of 0.8.x wrote, so
 * slot 1 keeps working for every existing user; the rest are free slots the
 * card fills in order as the user keeps adding keys (the credentials Remote
 * namespace cannot read a value back, so the card addresses keys by slot rather
 * than by a stored list). Unconfigured slots cost nothing but one in-process
 * resolve per operation.
 */
export const KEY_REFS = [
  'JINA_API_KEY',
  'JINA_API_KEY_2',
  'JINA_API_KEY_3',
  'JINA_API_KEY_4',
  'JINA_API_KEY_5',
  'JINA_API_KEY_6',
  'JINA_API_KEY_7',
  'JINA_API_KEY_8',
  'JINA_API_KEY_9',
  'JINA_API_KEY_10',
]

/** The primary slot — the reference the pre-pool card already wrote. */
export const PRIMARY_KEY_REF = KEY_REFS[0]

/** The key file the pool falls back to (workspace first, then the dsh home). */
export const KEY_FILE = 'jina-api-key.txt'

/**
 * HTTP statuses that mean "this key cannot serve this call" — rotate to the
 * next one. Anything else (0 network, 422 bad arguments, 5xx upstream) is not
 * a key problem: rotating would waste requests and hide the real cause.
 */
export const KEY_FAILOVER_STATUSES = [401, 402, 429]

/**
 * How long a failed key is skipped before the rotation tries it again.
 *   - 401 — a revoked/expired key cannot heal while the stored value is the
 *     same, so this is long enough to be effectively "until the pool changes"
 *     without making a spurious 401 permanent.
 *   - 402 — the account can be topped up at any moment, so a short cooldown
 *     keeps the key in play (one wasted request per cooldown, at most).
 *   - 429 — transient by definition.
 */
export const KEY_BLOCK_MS = {
  401: 30 * 60 * 1000,
  402: 5 * 60 * 1000,
  429: 60 * 1000,
}

/** Status tokens the host and the card exchange for one key. */
export const KEY_STATUS = {
  ok: 'ok',
  untried: 'untried',
  invalid: 'invalid',
  quota: 'quota',
  rate: 'rate',
  offline: 'offline',
  error: 'error',
}

/** Human-readable label per status token (the plugin's user-facing language). */
const STATUS_LABELS = {
  ok: '正常',
  untried: '未使用',
  invalid: '无效（HTTP 401）',
  quota: '额度耗尽（HTTP 402）',
  rate: '限流（HTTP 429）',
  offline: '网络不可达',
  error: '调用失败',
}

/** Whether one HTTP status is a key problem the rotation must react to. */
export function isKeyFailoverStatus(status) {
  return KEY_FAILOVER_STATUSES.includes(Number(status))
}

/** Map one observed HTTP status to a status token. */
export function keyStatusOf(status) {
  const code = Number(status)
  if (code >= 200 && code < 300) return KEY_STATUS.ok
  if (code === 401) return KEY_STATUS.invalid
  if (code === 402) return KEY_STATUS.quota
  if (code === 429) return KEY_STATUS.rate
  if (code === 0) return KEY_STATUS.offline
  return KEY_STATUS.error
}

/**
 * Explain one status token (and the raw status, when it adds information).
 * @param token - a {@link KEY_STATUS} value.
 * @param status - the raw HTTP status the token came from.
 * @returns the user-facing label.
 */
export function describeKeyStatus(token, status) {
  const known = Object.prototype.hasOwnProperty.call(STATUS_LABELS, token)
  const effective = known ? token : KEY_STATUS.error
  const label = STATUS_LABELS[effective]
  if (effective === KEY_STATUS.error && status !== undefined && status !== null) return label + '（HTTP ' + status + '）'
  return label
}

/**
 * Parse the key file: one key per line, blank lines and `#` comments ignored,
 * duplicates collapsed. A single-line file (what 0.8.x documented) still
 * yields exactly one key.
 * @param text - the raw file contents (any type; non-strings yield nothing).
 * @returns the keys in file order.
 */
export function parseKeyList(text) {
  if (typeof text !== 'string') return []
  const seen = new Set()
  const keys = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (seen.has(line)) continue
    seen.add(line)
    keys.push(line)
  }
  return keys
}

/**
 * A signature for one resolved pool, used to reset the rotation state when the
 * user saves or clears a key. It is a djb2 hash, never the values themselves:
 * the rotation state must not become a second place secrets live.
 * @param keys - the pool, as values or as `{ value }` entries.
 * @returns a stable 32-bit signature.
 */
export function keyPoolSignature(keys) {
  const list = Array.isArray(keys) ? keys : []
  let hash = 5381
  for (const entry of list) {
    const value = typeof entry === 'string' ? entry : (entry && typeof entry.value === 'string' ? entry.value : '')
    hash = ((hash * 33) ^ value.length) >>> 0
    for (let i = 0; i < value.length; i++) hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0
  }
  return hash
}

/** A fresh rotation state for one key: healthy, never failed. */
export function clearKeyState() {
  return { status: KEY_STATUS.ok, until: 0, lastStatus: 200, at: 0 }
}

/** Whether one key is currently cooling down after a failover status. */
export function isKeyBlocked(state, now) {
  if (state === null || typeof state !== 'object') return false
  return typeof state.until === 'number' && state.until > now
}

/**
 * Fold one observed status into a key's rotation state.
 *
 * A success clears the cooldown. A failover status records the token and the
 * cooldown for it. Any other status is left alone: it is not evidence about
 * the key, so it must not park a working key.
 *
 * @param state - the previous state (or undefined).
 * @param status - the HTTP status just observed.
 * @param now - the current epoch milliseconds.
 * @returns the next state.
 */
export function keyStateAfter(state, status, now) {
  const base = state !== null && typeof state === 'object' ? state : clearKeyState()
  const code = Number(status)
  if (code >= 200 && code < 300) return clearKeyState()
  if (!isKeyFailoverStatus(code)) return base
  const block = KEY_BLOCK_MS[code]
  return {
    status: keyStatusOf(code),
    until: typeof block === 'number' ? now + block : 0,
    lastStatus: code,
    at: now,
  }
}

/**
 * The order the pool is walked for one call.
 *
 * Sticky first: the key that served the last success (or the first key when
 * nothing has been tried) leads, then the rest of the pool wraps around it.
 * Keys in cooldown are demoted to the back — skipped entirely while at least
 * one healthy key remains, but still tried (in rotation order) when the whole
 * pool is cooling down, so an exhausted pool fails honestly instead of the
 * plugin refusing to call the API at all.
 *
 * @param count - pool size.
 * @param activeIndex - the preferred index (clamped into range).
 * @param states - the per-index states, parallel to the pool.
 * @param now - the current epoch milliseconds.
 * @returns indices in the order to try.
 */
export function keyRotationOrder(count, activeIndex, states, now) {
  const size = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  if (size === 0) return []
  const list = Array.isArray(states) ? states : []
  const start = Number.isFinite(activeIndex) ? ((Math.floor(activeIndex) % size) + size) % size : 0
  const order = []
  for (let i = 0; i < size; i++) order.push((start + i) % size)
  const ready = order.filter((index) => !isKeyBlocked(list[index], now))
  return ready.length > 0 ? ready : order
}

/**
 * The user-facing label for one pool entry's source.
 * @param entry - `{ source, ref?, line? }` as index.js builds it.
 * @returns a short label for error text and the card.
 */
export function keySourceLabel(entry) {
  const e = entry !== null && typeof entry === 'object' ? entry : {}
  if (e.source === 'credential') return '凭据 ' + String(e.ref || PRIMARY_KEY_REF)
  if (e.source === 'request') return '调用参数 apiKey'
  if (e.source === 'workspace-file') return '工作区 ' + KEY_FILE + ' 第 ' + (e.line || 1) + ' 行'
  if (e.source === 'home-file') return 'dsh 主目录 ' + KEY_FILE + ' 第 ' + (e.line || 1) + ' 行'
  return String(e.source || '未知来源')
}
