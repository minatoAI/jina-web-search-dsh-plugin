/**
 * dsh-jina — settings and endpoint policy (pure helpers, zero dependencies).
 *
 * Two concerns live here, both of them policy rather than transport:
 *
 * 1. The `jina-tools` settings namespace: which Jina host pair a call uses
 *    (`endpoint`) and the reader policy the tools fall back to (image handling
 *    and the selector overrides). The namespace *is* a Loader entry id
 *    (contributed by this bundle's `cordis.patch.yml`) and `index.js` exports
 *    the `Config` this module builds, so a field saved on the card reaches the
 *    running plugin without a restart.
 *
 * 2. The endpoint policy. Jina's global hosts (`r.jina.ai`, `s.jina.ai`) are
 *    DNS-poisoned from mainland China and their origin addresses are
 *    blackholed, so a call from there fails at connect time. The vendor
 *    publishes official mainland mirrors — `r.jinaai.cn` and `s.jinaai.cn`,
 *    served from a domestic CDN, same API, same parameters, same auth — and
 *    documents them as the replacement domain (jina-ai/reader#1237). The
 *    policy below decides the order in which the two host pairs are tried and
 *    which one the process then sticks to; it never touches a proxy, because
 *    the CN hosts are reachable directly and a local VPN is exactly the moving
 *    part this route exists to remove.
 *
 * Precedence of the endpoint mode:
 *   - `cn`     — mainland mirrors only (no proxy, no fallback: the user pinned it)
 *   - `global` — Jina's global hosts only
 *   - `auto`   — try the side that answered last, then the other one; a call
 *                only ever spends two attempts and never repeats one host
 *
 * Kept free of Cordis / ctx / network dependencies so the policy is
 * unit-testable without a running harness (see test/settings.test.js).
 */

/** Settings namespace the "Jina Tools" card edits; the host half serves it. */
export const SETTINGS_NAMESPACE = 'jina-tools'

// ---- endpoint policy -------------------------------------------------------

/** Settings field: which Jina host pair every call uses. */
export const ENDPOINT_FIELD = 'endpoint'

/** The values `endpoint` accepts, in card order. */
export const ENDPOINT_MODES = ['auto', 'global', 'cn']

/** What an unset `endpoint` means: pick by reachability, prefer what worked. */
export const DEFAULT_ENDPOINT_MODE = 'auto'

/**
 * The two host pairs, per API family.
 *
 * `search` deliberately points at `s.jina.ai` rather than the `svip.jina.ai`
 * the plugin used before: `s.jina.ai` is the documented search endpoint, its
 * mainland mirror is `s.jinaai.cn`, and both answer the same
 * `{ code, status, data: [...] }` shape — so one formatter covers every route.
 * The one field that does not survive the move is `domain` (ignored by
 * `s.jina.ai`); `site` is honoured instead, which is what `index.js` sends for
 * the arxiv / ssrn shortcuts.
 */
export const ENDPOINT_HOSTS = {
  reader: { global: 'https://r.jina.ai/', cn: 'https://r.jinaai.cn/' },
  search: { global: 'https://s.jina.ai/', cn: 'https://s.jinaai.cn/' },
}

/** API families a call can belong to. */
export const ENDPOINT_KINDS = ['reader', 'search']

/**
 * The suffix a CN request must bypass any inherited proxy with.
 *
 * The plugin no longer configures a proxy, but the harness resolves its own
 * outbound policy from the launching environment and hands the subprocess a
 * base that may already carry `HTTP_PROXY` / `HTTPS_PROXY`. A CN host is a
 * domestic CDN address: sending it through a VPN is at best slower and at
 * worst the hang this whole route exists to avoid, so the CN attempt adds its
 * own suffix to `NO_PROXY` (and never drops the inherited list).
 */
export const CN_NO_PROXY = 'jinaai.cn'

/**
 * Read the endpoint mode out of a resolved `jina-tools` section.
 * @param section - the resolved settings value (any shape).
 * @returns one of {@link ENDPOINT_MODES}; anything unknown means `auto`.
 */
export function endpointModeOf(section) {
  if (section === null || typeof section !== 'object') return DEFAULT_ENDPOINT_MODE
  const value = section[ENDPOINT_FIELD]
  return typeof value === 'string' && ENDPOINT_MODES.includes(value) ? value : DEFAULT_ENDPOINT_MODE
}

/**
 * The hosts one call tries, in order, for one API family.
 *
 * A pinned mode yields exactly one candidate, so a failure is reported instead
 * of being papered over by the other side. `auto` yields both, starting with
 * the side that answered last — the process learns which side works on its
 * first call and stops paying for the other one, and it still falls back if
 * that side later breaks.
 *
 * @param mode - `'auto' | 'global' | 'cn'` (already validated).
 * @param kind - `'reader' | 'search'`; an unknown kind reads as `reader`.
 * @param preferred - the side that answered last (`'global'` before any call).
 * @returns `[{ side, base }]` — one or two candidates, in try order.
 */
export function routePlan(mode, kind, preferred) {
  const hosts = ENDPOINT_HOSTS[ENDPOINT_KINDS.includes(kind) ? kind : 'reader']
  if (mode === 'cn') return [{ side: 'cn', base: hosts.cn }]
  if (mode === 'global') return [{ side: 'global', base: hosts.global }]
  const first = preferred === 'cn' ? 'cn' : 'global'
  const second = first === 'cn' ? 'global' : 'cn'
  return [{ side: first, base: hosts[first] }, { side: second, base: hosts[second] }]
}

/**
 * The environment overlay that keeps a CN attempt off any inherited proxy.
 *
 * @param inheritedNoProxy - `process.env.NO_PROXY` (either casing) or anything else.
 * @returns `{ NO_PROXY, no_proxy }` with the CN suffix appended once.
 */
export function cnBypassEnv(inheritedNoProxy) {
  const base = typeof inheritedNoProxy === 'string' ? inheritedNoProxy.trim() : ''
  const already = base.split(',').map((part) => part.trim()).includes(CN_NO_PROXY)
  const list = base === '' ? CN_NO_PROXY : (already ? base : base + ',' + CN_NO_PROXY)
  return { NO_PROXY: list, no_proxy: list }
}

// ---- reader defaults -------------------------------------------------------
// The `jina-tools` namespace carries the reader policy next to the endpoint
// mode. Everything here is a *default* the tools fall back to; each value
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

/**
 * Resolve the `jina-tools` section into the policy the tools consume.
 *
 * Every field is optional in the document, so this is where "unset" becomes a
 * concrete default. It never throws: a missing provider (`undefined`), a
 * hand-edited scalar, or an unknown value all resolve to a usable policy, the
 * same contract the settings seam relies on.
 *
 * @param section - the resolved settings value (any shape).
 * @returns `{ endpoint, imagePolicy, autoAltText, useSelectors,
 *            targetSelector, removeSelector, waitForSelector }`.
 */
export function toolSettingsOf(section) {
  const s = section !== null && typeof section === 'object' ? section : {}
  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : '')
  return {
    endpoint: endpointModeOf(s),
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
  [ENDPOINT_FIELD, 'string'],
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
 * over the raw config, the endpoint mode and the reader policy still apply
 * instead of silently collapsing to the defaults.
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
 * @returns whether `endpoint` is a cosmokit-compatible reference.
 */
export function settingsAreLive(config) {
  const ref = config !== null && typeof config === 'object' ? config[ENDPOINT_FIELD] : undefined
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
