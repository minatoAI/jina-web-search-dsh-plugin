/**
 * dsh-jina — proxy policy (pure helpers, zero dependencies).
 *
 * The Jina endpoints are unreachable from mainland China without a proxy. A
 * local proxy client (Clash / v2ray / Surge / …) that is deliberately NOT
 * enabled as the system proxy listens on a loopback port only: the Windows
 * WinINET registry discovery in index.js cannot see it, and neither can any
 * other system-level probe. This module owns the manual override and the
 * precedence the transport applies, so the user can simply type the address
 * of their own local proxy and have every Jina call ride it.
 *
 * Precedence (first usable candidate wins):
 *   1. `request` — transport-level override for one call (internal)
 *   2. `setting` — Settings → Plugins → Jina Tools → 本地代理地址
 *                  (the `proxyUrl` field of the `jina-tools` namespace)
 *   3. `envVar`  — the `JINA_PROXY_URL` environment variable, for headless
 *                  profiles that never mount a settings provider
 *   4. `system`  — the Windows system proxy discovered from WinINET
 *   5. (none)    — the harness-resolved proxy the subprocess seam already
 *                  carries (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY)
 *
 * Only http(s) proxies are usable: the network helper is a `node -e` script
 * using the global `fetch`, which honors proxy variables under
 * `NODE_USE_ENV_PROXY` — and Node exits at startup when that flag sees a
 * non-http(s) scheme. A SOCKS value is therefore reported as unusable instead
 * of being passed on silently.
 *
 * Kept free of Cordis / ctx / network dependencies so the policy is
 * unit-testable without a running harness (see test/proxy.test.js).
 */

/** Settings namespace the "Jina Tools" card edits; the host half serves it. */
export const SETTINGS_NAMESPACE = 'jina-tools'

/** Settings field holding the manually configured local proxy address. */
export const PROXY_SETTING_FIELD = 'proxyUrl'

// ---- reader defaults -------------------------------------------------------
// The `jina-tools` namespace carries the reader policy next to the proxy
// address. Everything here is a *default* the tools fall back to; each value
// can still be overridden per call (the tool parameters win), which is why the
// settings document only ever stores what the user actually changed.

/** Settings field: `X-Retain-Images` mode ('all' | 'alt' | 'none'). */
export const IMAGE_POLICY_FIELD = 'imagePolicy'
/** Settings field: let Jina caption images that lack alt text (paid feature). */
export const AUTO_ALT_SETTING_FIELD = 'autoAltText'
/** Settings field: apply the CSS selector group to reads by default. */
export const SELECTORS_SETTING_FIELD = 'useSelectors'
/** Settings field: `X-Target-Selector` override ('' = built-in default list). */
export const TARGET_SELECTOR_FIELD = 'targetSelector'
/** Settings field: `X-Remove-Selector` override ('' = built-in default list). */
export const REMOVE_SELECTOR_FIELD = 'removeSelector'
/** Settings field: `X-Wait-For-Selector` override ('' = none). */
export const WAIT_FOR_SELECTOR_FIELD = 'waitForSelector'

/** `X-Retain-Images` modes the API accepts (the API default is `all`). */
export const IMAGE_POLICIES = ['all', 'alt', 'none']
export const DEFAULT_IMAGE_POLICY = 'all'

/**
 * The header values every read sends regardless of settings — the three
 * "no-regret" knobs from the Reader API:
 *   - `X-Preset: agent`  — the vendor's own preset for AI agents. Presets fill
 *     only options the caller did not set explicitly, so this is a baseline,
 *     never an override.
 *   - `X-Base: final`    — resolve relative links against the post-redirect URL
 *     (zero cost; without it a redirect silently breaks every relative link).
 *   - `X-Timeout: 120`   — Jina's page-load patience, matched to the client's own
 *     ceiling (the transport aborts at 120000 ms). Sending 180 — the documented
 *     maximum — would be pointless here: the client would give up first and
 *     report its own timeout instead of Jina's. Raise both together or neither.
 */
export const READER_PRESET = 'agent'
export const READER_BASE = 'final'
export const READER_TIMEOUT_SECONDS = 120

/**
 * Conservative `X-Target-Selector` default: only containers that reliably mean
 * "this is the article". `X-Target-Selector` implies `X-Wait-For-Selector` with
 * the same value, so a selector that matches nothing costs a wait — which is
 * why index.js retries without the group when the result comes back too short.
 */
export const DEFAULT_TARGET_SELECTORS = 'article, main, [role="main"], [role="article"], .markdown-body, .post-content, .article-body, .entry-content, [itemprop="articleBody"]'

/**
 * Conservative `X-Remove-Selector` default: unambiguous page chrome only.
 * Deliberately excludes anything that can *be* the content container in an SPA
 * (`.modal`, `.popup`, `.overlay`, `.content`), because removing those returns
 * an empty page.
 */
export const DEFAULT_REMOVE_SELECTORS = 'header, footer, nav, [role="navigation"], [role="banner"], [role="contentinfo"], .navbar, .site-header, .site-footer, .cookie-banner, .consent-banner, .ads, .advertisement, .sidebar, .comments, .newsletter-signup'

/**
 * Below this many characters a read is treated as "the target selector matched
 * nothing" and retried without the selector group.
 */
export const SELECTOR_RETRY_MIN_CHARS = 200

/** Environment variable carrying a deployment-wide manual proxy address. */
export const PROXY_ENV_VAR = 'JINA_PROXY_URL'

/**
 * Proxy variables a harness-resolved environment may carry, in inspection
 * order. Both cases are listed because Windows tooling and dsh itself differ.
 */
export const PROXY_ENV_VARS = [
  'HTTPS_PROXY', 'https_proxy',
  'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy',
]

/** Human-readable reason a candidate address was rejected. */
const REJECT_REASONS = {
  empty: '地址为空',
  type: '地址不是字符串',
  invalid: '不是有效的主机:端口地址',
  scheme: '不支持的协议（网络 helper 只支持 http:// 与 https:// 代理）',
}

/** Explain one rejection reason (the plugin's user-facing language). */
export function describeRejectReason(reason) {
  return REJECT_REASONS[reason] || String(reason)
}

/**
 * Parse one proxy address into a transport-usable URL.
 *
 * Accepts `127.0.0.1:7897` (scheme defaults to http), `http://host:port`,
 * `https://host:port` and credentials-bearing forms. A path, query, or
 * fragment is dropped — a proxy address is an origin. Anything without a host,
 * or with a scheme the Node helper cannot use, comes back `usable: false`
 * with the normalized-or-raw URL preserved for display.
 *
 * @param raw - the user/config-supplied address.
 * @returns `{ url, usable, reason }`; `url` is '' when nothing parsed at all.
 */
export function parseProxyAddress(raw) {
  if (typeof raw !== 'string') {
    return { url: '', usable: false, reason: raw === undefined || raw === null || raw === '' ? 'empty' : 'type' }
  }
  const value = raw.trim()
  if (value === '') return { url: '', usable: false, reason: 'empty' }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'http://' + value
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    return { url: '', usable: false, reason: 'invalid' }
  }
  if (parsed.hostname === '') return { url: '', usable: false, reason: 'invalid' }
  const scheme = parsed.protocol.toLowerCase()
  const auth = parsed.username === ''
    ? ''
    : parsed.username + (parsed.password === '' ? '' : ':' + parsed.password) + '@'
  const url = scheme + '//' + auth + parsed.host
  if (scheme !== 'http:' && scheme !== 'https:') return { url, usable: false, reason: 'scheme' }
  return { url, usable: true, reason: 'ok' }
}

/**
 * Read the manual proxy field out of a resolved `jina-tools` section.
 * @param section - the resolved settings value (any shape).
 * @returns the stored string, or '' when unset/non-string.
 */
export function proxySettingOf(section) {
  if (section === null || typeof section !== 'object') return ''
  const value = section[PROXY_SETTING_FIELD]
  return typeof value === 'string' ? value : ''
}

/**
 * First non-empty proxy variable in an environment-like object.
 * @param env - `process.env` or any plain object.
 * @returns the raw variable value, or ''.
 */
export function envProxyValue(env) {
  if (env === null || typeof env !== 'object') return ''
  for (const name of PROXY_ENV_VARS) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * Apply the precedence above to one operation's candidate addresses.
 *
 * A candidate that is present but unusable never wins; it is recorded in
 * `rejected` so the UI and the error text can report it rather than pretend
 * the user configured nothing.
 *
 * @param input - `{ request?, setting?, envVar?, system?, env? }`.
 * @returns `{ url, source, envHint, rejected }`; `url` is undefined when no
 *   candidate is usable, and `source` then names the inherited layer
 *   (`'environment'`) or nothing at all (`'none'`).
 */
export function selectProxy(input) {
  const env = (input && input.env) || {}
  const envHint = envProxyValue(env)
  const rejected = []
  const consider = (field, raw) => {
    if (typeof raw !== 'string' || raw.trim() === '') return undefined
    const parsed = parseProxyAddress(raw)
    if (parsed.usable) return { url: parsed.url, source: field }
    rejected.push({ field, value: raw.trim(), reason: parsed.reason, message: describeRejectReason(parsed.reason) })
    return undefined
  }
  const hit = consider('request', input && input.request)
    || consider('setting', input && input.setting)
    || consider('envVar', input && input.envVar)
    || consider('system', input && input.system)
  if (hit) return { url: hit.url, source: hit.source, envHint, rejected }
  return { url: undefined, source: envHint === '' ? 'none' : 'environment', envHint, rejected }
}

/**
 * Resolve the `jina-tools` section into the reader policy the tools consume.
 *
 * Every field is optional in the document, so this is where "unset" becomes a
 * concrete default. It never throws: a missing provider (`undefined`), a
 * hand-edited scalar, or an unknown value all resolve to a usable policy, the
 * same contract `settingProxy()` already relies on.
 *
 * @param section - the resolved settings value (any shape).
 * @returns `{ proxyUrl, imagePolicy, autoAltText, useSelectors,
 *            targetSelector, removeSelector, waitForSelector }`.
 */
export function toolSettingsOf(section) {
  const s = section !== null && typeof section === 'object' ? section : {}
  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : '')
  return {
    proxyUrl: proxySettingOf(s),
    imagePolicy: IMAGE_POLICIES.includes(s[IMAGE_POLICY_FIELD]) ? s[IMAGE_POLICY_FIELD] : DEFAULT_IMAGE_POLICY,
    // Opt-in, because supplying a key is what makes a read billable: defaulting
    // this to true would silently turn every anonymous (free) read into a
    // charged one for any user who has a key configured.
    autoAltText: s[AUTO_ALT_SETTING_FIELD] === true,
    // Selectors are free and only ever remove chrome, so they default to ON.
    useSelectors: s[SELECTORS_SETTING_FIELD] !== false,
    // '' means "use the built-in conservative list" (see the constants above).
    targetSelector: text(s[TARGET_SELECTOR_FIELD]),
    removeSelector: text(s[REMOVE_SELECTOR_FIELD]),
    waitForSelector: text(s[WAIT_FOR_SELECTOR_FIELD]),
  }
}

/** cosmokit's cross-copy volatile protocol: `ref[VOLATILE_WRITE](next)`. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** The live fields, in card order: `[key, schemastery type]`. */
const SETTINGS_FIELDS = [
  [PROXY_SETTING_FIELD, 'string'],
  [IMAGE_POLICY_FIELD, 'string'],
  [AUTO_ALT_SETTING_FIELD, 'boolean'],
  [SELECTORS_SETTING_FIELD, 'boolean'],
  [TARGET_SELECTOR_FIELD, 'string'],
  [REMOVE_SELECTOR_FIELD, 'string'],
  [WAIT_FOR_SELECTOR_FIELD, 'string'],
]

/**
 * One live config value: the object the loader mutates in place when the user
 * saves this field.
 *
 * `get()` returns the raw stored value — `undefined` while the user never set
 * the field — so the stored document stays minimal and every default stays in
 * `toolSettingsOf` ("unset" keeps meaning "default"). Frozen like cosmokit's
 * `createVolatile`: the write handle is a symbol-keyed closure, so freezing
 * only prevents reassigning it.
 *
 * @param value - the raw stored value (`undefined` when unset).
 * @returns `{ get() }` plus the cosmokit write handle.
 */
function volatileRef(value) {
  let current = value
  const ref = { get: () => current }
  Object.defineProperty(ref, VOLATILE_WRITE, { value: (next) => { current = next } })
  return Object.freeze(ref)
}

/**
 * Read the current `jina-tools` section out of the resolved config `apply`
 * receives, unwrapping the volatile references.
 *
 * Tolerates a plain (already unwrapped) section too: if a harness copy hands
 * over the raw config, the manual proxy address and the reader policy still
 * apply instead of silently collapsing to the defaults.
 *
 * @param config - the second argument of `apply` (any shape).
 * @returns a section of plain values, `undefined` for every unset field.
 */
export function settingsSnapshot(config) {
  const out = {}
  if (config === null || typeof config !== 'object') return out
  for (const [field] of SETTINGS_FIELDS) {
    const value = config[field]
    out[field] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  return out
}

/**
 * Whether the config `apply` received carries live references — the health
 * check for the settings seam itself. `false` means the harness never resolved
 * this plugin's `Config` (or resolved it as raw data), which is exactly the
 * state in which the settings card renders but every field is read-only.
 *
 * @param config - the second argument of `apply` (any shape).
 * @returns whether `proxyUrl` is a cosmokit-compatible reference.
 */
export function settingsAreLive(config) {
  const ref = config !== null && typeof config === 'object' ? config[PROXY_SETTING_FIELD] : undefined
  return ref !== null && typeof ref === 'object' && typeof ref.get === 'function' && VOLATILE_WRITE in ref
}

/**
 * Build the live-config schema for the `jina-tools` Loader entry.
 *
 * dsh 0.1.4 removed `settings.register`: a settings namespace *is* a Loader
 * entry id (here `jina-tools`, contributed by this bundle's
 * `cordis.patch.yml`), and a plugin declares its live fields by exporting a
 * schemastery `Config`. The harness then
 *   - resolves it through `runtime.Config['~standard'].validate(raw)` (Standard
 *     Schema v1) and passes the result to `apply(ctx, config)`,
 *   - serializes `toJSON()` into the `settings.describe()` row the browser card
 *     reads, and
 *   - treats a field as *live* when its node carries `meta.volatile`.
 *
 * Volatility is what makes a save reach the running plugin without a restart:
 * the loader diffs the new raw config with `equalExceptVolatile` and, when only
 * volatile fields moved, calls `updateVolatile(ref, next)` on the references the
 * resolved config holds instead of remounting the plugin. Those references must
 * speak cosmokit's cross-copy protocol (`Symbol.for`, so any ESM/CJS copy of the
 * harness recognizes them), which is why this module builds them itself.
 *
 * The plugin runs out of tree and cannot import the harness's schemastery, so
 * this is a duck-typed node covering exactly the surface the runtime touches:
 * `type`/`dict`/`meta` (the loader's volatile diff and the settings form
 * projection), `toJSON()` (rehydrated by the browser as `new Schema(json)`), and
 * `'~standard'`. `~standard.vendor` reports `'schemastery'` because that is the
 * duck-type the loader's volatile diff probes for — any other vendor demotes
 * every save to a full plugin remount. The node stays callable as well, because
 * an older harness copy resolves a config schema by calling it.
 *
 * Shape notes (verified against schemastery 3.18.3):
 *   - a dict entry must carry `meta`, otherwise the rehydrated `string` resolver
 *     dereferences `meta.pattern` on undefined (`new Schema(serialized)` assigns
 *     the serialized dict verbatim — plain objects are never converted into
 *     nodes);
 *   - `toJSON()` hands out freshly built nodes: the settings provider rehydrates
 *     the result and then deletes `meta.volatile` while walking it, so sharing
 *     the live nodes here would let a single settings read strip this schema of
 *     its volatility and turn every later save into a remount.
 *
 * @returns the `Config` schema this plugin exports as its live-field declaration.
 */
export function createSettingsSchema() {
  // Each live field is its own volatile node: `volatileForm` keeps exactly the
  // volatile children, and the write path then strips only those keys out of the
  // stored document, so a hand-written config keeps its undeclared keys.
  const fieldNode = (type) => ({
    type,
    meta: { volatile: true },
    toJSON() { return { type, meta: { volatile: true } } },
  })
  const dict = Object.fromEntries(SETTINGS_FIELDS.map(([key, type]) => [key, fieldNode(type)]))
  const resolve = (value) => {
    const section = value !== null && typeof value === 'object' ? value : {}
    const out = {}
    for (const [key] of SETTINGS_FIELDS) out[key] = volatileRef(section[key])
    return out
  }
  return Object.assign(resolve, {
    type: 'object',
    dict,
    meta: {},
    inner: undefined,
    toJSON() {
      return {
        type: 'object',
        meta: {},
        dict: Object.fromEntries(SETTINGS_FIELDS.map(([key, type]) => [key, { type, meta: { volatile: true } }])),
      }
    },
    '~standard': {
      version: 1,
      vendor: 'schemastery',
      validate(value) { return { value: resolve(value) } },
    },
  })
}
