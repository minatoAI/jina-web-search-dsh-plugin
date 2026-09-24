/**
 * dsh-jina — Jina AI tools for DeepSeek Harness.
 *
 * Host plugin: registers the eight jina_* model tools mirroring jina-cli
 * (search — with dedicated jina_search_arxiv / jina_search_ssrn academic
 * shortcuts so the model can hit the right domain without remembering the
 * `type` parameter — / read / read_pdf / screenshot / datetime / primer).
 * The API key lives in the host credential seam
 * under the reference `JINA_API_KEY` — the "Jina Tools" web settings page
 * writes it through `credentials.set`, and this plugin resolves it per
 * operation (the seam's contract: never cache across operations). The web
 * settings pairing: the `jina-tools` Loader entry (contributed by this bundle's
 * `cordis.patch.yml`) *is* the settings namespace, and this host half declares
 * its live fields through the module-level `Config` export built by settings.js —
 * `endpoint` selects the Jina host pair (mainland mirrors / global / auto) and
 * the remaining fields carry the reader policy (`imagePolicy`,
 * `autoAltText`, `useSelectors` and the selector overrides). The browser half
 * registers its configuration form for that namespace, so the Plugins page
 * (the `dsh-jina` bundle card) renders the form only when the two halves agree.
 *
 * The API key is resolved per call in this order:
 *   1. the tool's own `apiKey` parameter (one key, never rotated),
 *   2. the credential slots `JINA_API_KEY`, `JINA_API_KEY_2` …
 *      `JINA_API_KEY_10` (set from the web settings page, persisted by the host
 *      credential provider, e.g. `.credentials.yaml`) — every configured slot
 *      joins the pool, in slot order,
 *   3. `jina-api-key.txt` in the calling session's workspace (one key per line),
 *   4. `jina-api-key.txt` in the dsh home directory (`$DSH_HOME` or `~/.dsh`).
 *
 * A pool, not a key, is what an operation uses: the key that served the last
 * success leads, and a key that answers 401 / 402 (quota exhausted) / 429 is
 * parked for a cooldown and the next key is tried, so one overdrawn account no
 * longer interrupts a running task. A key that is definitively unusable is
 * discarded outright: 401, 402 and a probe reporting a balance of zero delete
 * that credential, so the pool cleans itself and the user never manages a list.
 * A switch made mid-call is reported in the result; a pool that is entirely
 * exhausted names every key it tried and the status each one answered.
 * `keys.js` owns the pure rotation policy.
 *
 * Network transport: the Jina endpoints are contacted through a small
 * `node -e` fetch helper spawned via the host `subprocess` service. Which host
 * pair a call talks to is decided per call by settings.js:
 *   1. `cn`     — the vendor's official mainland mirrors (`r.jinaai.cn`,
 *      `s.jinaai.cn`), served from a domestic CDN with the same API, the same
 *      parameters and the same auth. The attempt adds `jinaai.cn` to
 *      `NO_PROXY` so a proxy inherited from the launching environment cannot
 *      capture it — these hosts are why the plugin needs no VPN at all.
 *   2. `global` — `r.jina.ai` / `s.jina.ai`. Both are DNS-poisoned and their
 *      origins blackholed from mainland China, where this side fails at
 *      connect time.
 *   3. `auto`   — try the side that answered last, then the other one. At most
 *      two attempts per call, never the same host twice, and the winner is
 *      remembered for the rest of the process.
 * A transport failure reports every host it tried, so "no route at all" is
 * visible instead of looking like a generic network outage.
 */

import { homedir } from 'node:os'
import {
  KEY_FILE, KEY_REFS, clearKeyState, describeKeyStatus, isKeyFailoverStatus,
  keyPoolSignature, keyRotationOrder, keySourceLabel, keyStateAfter, keyStatusOf,
  parseKeyList,
} from './keys.js'
import { buildPrimer, formatPrimer, parseIpInfo, parseJinaRoot } from './primer.js'
import {
  DEFAULT_REMOVE_SELECTORS, DEFAULT_TARGET_SELECTORS,
  READER_BASE, READER_PRESET, READER_TIMEOUT_SECONDS, SELECTOR_ATTEMPT_TIMEOUT_MS,
  SELECTOR_RETRY_MIN_CHARS, SELECTOR_WAIT_TIMEOUT_SECONDS,
  cnBypassEnv, createSettingsSchema, routePlan,
  settingsAreLive, settingsSnapshot, toolSettingsOf,
} from './settings.js'
import { WEB_SEARCH_TOOL } from './tool-contracts.js'

export const name = 'dsh-jina'

export const inject = ['fs', 'subprocess', 'tools']

/**
 * The `jina-tools` live-field declaration.
 *
 * The entry id *is* the settings namespace (`cordis.patch.yml` contributes
 * `- id: jina-tools / name: dsh-jina`), and this export is what the settings
 * provider serves to the browser half: the harness resolves it through
 * `'~standard'.validate`, hands the result to `apply` as the second argument,
 * and writes every saved field straight into the volatile references that
 * result holds. That is what makes a save live: the card is editable only while
 * a row for this namespace exists, and this plugin is the row's only source.
 *
 * settings.js owns the field list, the defaults and the cross-copy volatile
 * protocol; keeping the schema there is also what preserves the zero-dependency
 * promise (an out-of-tree bundle at this location cannot resolve the harness's
 * schemastery package).
 */
export const Config = createSettingsSchema()

/**
 * The network helper: a self-contained CommonJS script run as
 * `node -e <script>` by the host `subprocess` service. It reads one JSON
 * request from stdin and writes one JSON result to stdout, so the transport
 * never depends on a bundled HTTP client. Exported because it is the exact
 * code a routing problem has to be diagnosed against (see
 * test/plugin-endpoints.test.js and README → 开发说明).
 */
export const HTTP_HELPER_SCRIPT = [
  "const fs = require('fs')",
  "let input = ''",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', function (c) { input += c })",
  "process.stdin.on('end', function () {",
  "  let req = {}",
  "  try { req = JSON.parse(input || '{}') } catch (e) {",
  "    process.stdout.write(JSON.stringify({ ok: false, status: 0, text: 'bad request json: ' + e.message }), function () { process.exit(0) })",
  "    return",
  "  }",
  "  setTimeout(function () { process.exit(1) }, ((req && req.timeoutMs) || 60000) + 20000).unref()",
  "  try {",
  "    const options = { method: req.method || 'POST', headers: req.headers || {}, redirect: 'follow', signal: AbortSignal.timeout(req.timeoutMs || 60000) }",
  "    if (req.body !== undefined && req.body !== null) options.body = req.body",
  "    fetch(req.url, options).then(async function (res) {",
  "      const text = await res.text()",
  "      process.stdout.write(JSON.stringify({ ok: res.status >= 200 && res.status < 300, status: res.status, text: text }), function () { process.exit(0) })",
  "    }).catch(function (err) {",
  "      let detail = (err && err.message) || String(err)",
  "      if (err && err.name === 'TimeoutError') detail = 'timeout after ' + ((req && req.timeoutMs) || 60000) + 'ms'",
  "      if (err && err.cause && err.cause.message) detail = detail + ' (' + err.cause.message + ')'",
  "      process.stdout.write(JSON.stringify({ ok: false, status: 0, text: detail }), function () { process.exit(0) })",
  "    })",
  "  } catch (err) {",
  "    process.stdout.write(JSON.stringify({ ok: false, status: 0, text: 'helper error: ' + ((err && err.message) || String(err)) }), function () { process.exit(0) })",
  "  }",
  "})",
].join('\n')

export function apply(ctx, config) {
  const IPINFO = 'https://ipinfo.io/json'
  const MAX_OUT = 1500000
  /**
   * The client ceiling for a read that carries no target selector, matched to
   * the `X-Timeout: 120` every read sends. A read that *does* carry one runs on
   * `SELECTOR_ATTEMPT_TIMEOUT_MS` instead (settings.js explains why).
   */
  const READ_TIMEOUT_MS = 120000

  let nodePath
  /**
   * The key-file fallback, cached 30s like the single-key version was: the
   * parsed keys of the first non-empty candidate file, or `[]`. `undefined`
   * means "not read yet". The 401 path clears it so a file edited mid-session
   * is picked up without waiting the cache out.
   */
  let filePoolCache = { keys: undefined, at: 0 }
  let keyDiag = ''
  /**
   * Rotation state for the pool currently resolved: a signature (so saving or
   * clearing a key resets it), one state per pool index, and the round-robin
   * cursor (`lastUsed`, -1 before any call). In-memory only — a restart starts
   * from the first slot.
   */
  let keyPoolState = { signature: 0, states: [], lastUsed: -1 }
  /**
   * The endpoint side that answered last (`'global'` before any call). `auto`
   * mode tries it first and the other side second, so the process pays for the
   * unreachable side once and then stops — and still falls back if the working
   * side breaks later. In-memory only: a restart starts from the global side.
   */
  let preferredSide = 'global'
  /**
   * The resolved `jina-tools` config for this plugin instance (see the `Config`
   * export above). The harness keeps this object's identity stable and writes a
   * saved field into its volatile references in place, so reading through
   * `settingsSnapshot()` at the start of an operation always sees the current
   * values — the same "never cache across operations" contract the API key has.
   * `undefined` on a harness that passes no config, which is why the readers
   * below fall back to the settings.js defaults.
   */
  const settingsConfig = config
  let currentCwd = undefined

  /** dsh home directory: $DSH_HOME, else ~/.dsh. */
  function dshHome() {
    if (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) return process.env.DSH_HOME
    return homedir() + '/.dsh'
  }

  function workspaceRoot() {
    const sp = ctx.get('sandboxPolicy')
    if (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot.length > 0) return sp.workspaceRoot
    return homedir()
  }

  /** The calling agent's per-session workspace (canonical: exec.agent.session.header.cwd). */
  function sessionCwdOf(exec) {
    try {
      const c = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
      if (typeof c === 'string' && c.length > 0) return c
    } catch (e) { /* guarded */ }
    return undefined
  }

  function resolveRoot() {
    if (currentCwd) return currentCwd
    return workspaceRoot()
  }

  async function resolveNode() {
    if (nodePath === undefined) {
      try { nodePath = await ctx.subprocess.resolveExecutable('node') } catch (err) { nodePath = null }
    }
    return nodePath
  }

  function runCollect(argv, stdinData, maxBytes, env, signal) {
    return new Promise((resolve) => {
      const out = { exitCode: -1, stdout: { text: '' }, stderr: { text: '' } }
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv,
          cwd: resolveRoot(),
          stdio: {
            stdin: stdinData === undefined ? 'ignore' : { data: stdinData },
            stdout: { maxBytes: maxBytes || 65536, spill: { maxBytes: (maxBytes || 65536) * 4 } },
            stderr: { maxBytes: 65536, spill: { maxBytes: 262144 } },
          },
          graceMs: 2000,
          ...(signal !== undefined ? { signal } : {}),
          ...(env !== undefined ? { env } : {}),
        })
      } catch (err) {
        out.stderr.text = 'spawn failed: ' + String((err && err.message) || err)
        resolve(out)
        return
      }
      const finish = (err, outcome) => {
        try {
          if (err) out.stderr.text = String((err && err.message) || err)
          else {
            const so = handle.collected.stdout.readFrom(0)
            const se = handle.collected.stderr.readFrom(0)
            // The handle contract exposes exit facts through `done`
            // (SubprocessOutcome), not as a property on the handle itself.
            out.exitCode = outcome ? outcome.exitCode : undefined
            out.stdout = { text: so.text, lossy: so.lossy, spillPath: so.spillPath }
            out.stderr = { text: se.text }
          }
        } catch (e) { /* keep defaults */ }
        resolve(out)
      }
      handle.done.then((outcome) => finish(null, outcome), (err) => finish(err))
    })
  }

  /**
   * Resolve the rotation pool for one operation.
   *
   * Per-operation by contract: the credential seam documents that consumers
   * re-resolve at each operation so a changed credential reaches the next
   * operation without a restart. Every configured slot is resolved (one value
   * each — the seam stores one value per reference and never reads one back),
   * and the first source that yields at least one key wins, exactly as the
   * single-key lookup of 0.8.x did; the only change is that a source may now
   * contribute several keys and that the file may hold one key per line.
   *
   * @returns the pool, as `{ value, source, ref?, line? }` entries in try order.
   */
  async function loadKeyPool() {
    const keys = []
    const seen = new Set()
    const configured = []
    let unset = 0
    const notes = []
    const push = (raw, entry) => {
      const value = String(raw).trim()
      if (value === '' || seen.has(value)) return
      seen.add(value)
      keys.push({ ...entry, value })
    }
    try {
      const svc = ctx.get('credentials')
      if (svc === undefined) {
        notes.push('credential service absent')
      } else {
        for (const ref of KEY_REFS) {
          try {
            const resolved = await svc.resolve(ref)
            if (resolved && resolved.value) {
              // A slot may itself hold several keys (one per line) — a
              // hand-edited `.credentials.yaml` block scalar, or a key pasted
              // as a list. A real key never contains a newline, so splitting is
              // free and the whole pool keeps one parsing rule.
              const lines = parseKeyList(resolved.value)
              for (const value of lines) push(value, { source: 'credential', ref })
              configured.push(ref + '=' + String(resolved.source) + (lines.length > 1 ? '×' + lines.length : ''))
            } else {
              unset++
            }
          } catch (err) {
            configured.push(ref + '=' + String((err && err.message) || err))
          }
        }
      }
    } catch (err) {
      notes.push('credential lookup: ' + String((err && err.message) || err))
    }
    if (keys.length === 0) {
      // File sources: cached 30s; the 401 path invalidates and re-reads.
      if (filePoolCache.keys === undefined || Date.now() - filePoolCache.at >= 30000) {
        const root = resolveRoot()
        const home = dshHome()
        const candidates = [
          { source: 'workspace-file', path: root + '\\' + KEY_FILE, opts: undefined },
          { source: 'workspace-file', path: KEY_FILE, opts: { cwd: root } },
          { source: 'workspace-file', path: KEY_FILE, opts: undefined },
          { source: 'home-file', path: home + '\\' + KEY_FILE, opts: undefined },
          { source: 'home-file', path: KEY_FILE, opts: { cwd: home } },
        ]
        let found
        for (const c of candidates) {
          try {
            const target = await ctx.fs.resolve(c.path, c.opts)
            const lines = parseKeyList(await ctx.fs.readText(target))
            if (lines.length > 0) { found = { ...c, lines }; break }
            notes.push(c.source + ': empty file')
          } catch (err) {
            notes.push(c.source + ': ' + String((err && err.message) || err))
          }
        }
        filePoolCache = {
          keys: found === undefined
            ? []
            : found.lines.map((value, i) => ({ value, source: found.source, line: i + 1 })),
          at: Date.now(),
        }
        if (found !== undefined) notes.push(found.source + ': ' + found.lines.length + ' key(s)')
      } else {
        notes.push('file cache: hit (' + filePoolCache.keys.length + ' key(s))')
      }
      for (const entry of filePoolCache.keys) push(entry.value, entry)
    }
    // Compact on purpose: the diagnosis rides inside a user-facing error, and
    // listing every one of the ten unset slots would drown the useful part.
    keyDiag = 'credential slots: ' + (configured.length > 0
      ? configured.join(', ') + ' (' + unset + ' unset)'
      : 'none of ' + KEY_REFS.length + ' set')
      + (notes.length > 0 ? ' | key file: ' + notes.join('; ') : '')
    return keys
  }

  /** The first key of the pool — what a caller that only needs "a key exists" uses. */
  async function loadKey() {
    const keys = await loadKeyPool()
    return keys.length > 0 ? keys[0].value : undefined
  }

  /**
   * The rotation state for one resolved pool.
   *
   * A changed pool (a key added, discarded, replaced or cleared) resets the
   * cursor to the first slot and the cooldowns: the signature is what proves
   * the pool is the same one the states describe, a stale index would park the
   * wrong key, and re-verifying from the front is the honest reading of "the
   * pool changed, look again".
   * @param pool - the resolved pool.
   * @returns the live state object for that pool.
   */
  function keyStateFor(pool) {
    const signature = keyPoolSignature(pool)
    if (keyPoolState.signature !== signature || keyPoolState.states.length !== pool.length) {
      keyPoolState = { signature, states: pool.map(() => clearKeyState()), lastUsed: -1 }
    }
    return keyPoolState
  }

  /**
   * Discard one key that cannot serve a call any more.
   *
   * This is the whole "management" story of the pool: 401, 402 and a zero
   * balance delete the credential, so the user only ever adds keys. Only a
   * credential-sourced slot can be deleted — a key that came from a
   * `jina-api-key.txt` file is left alone (the plugin will not rewrite a user's
   * file) and a reference the launching environment supplies read-only is
   * refused by the seam; both fall back to the cooldown machinery.
   *
   * @param entry - the pool entry to discard.
   * @returns whether the credential was actually removed.
   */
  async function discardKey(entry) {
    if (entry === null || typeof entry !== 'object' || entry.source !== 'credential' || typeof entry.ref !== 'string') return false
    try {
      const svc = ctx.get('credentials')
      if (svc === undefined || typeof svc.unset !== 'function') return false
      await svc.unset(entry.ref)
      return true
    } catch (err) {
      return false
    }
  }

  /** The user-facing account of one failed key, for an error or a switch note. */
  function keyAttemptLabel(attempt) {
    const index = typeof attempt.index === 'number' ? attempt.index + 1 : '?'
    return '#' + index + '（' + keySourceLabel(attempt.entry) + '）' + describeKeyStatus(keyStatusOf(attempt.status), attempt.status)
      + (attempt.discarded === true ? '，已自动移除' : '')
  }

  /** The one-line note a successful call carries after a mid-call key switch. */
  function keySwitchNote(res) {
    if (res === null || typeof res !== 'object' || res.keySwitch === undefined || res.keySwitch === null) return ''
    const message = res.keySwitch.message
    return typeof message === 'string' && message !== '' ? '\n\n[' + message + ']' : ''
  }

  /**
   * Append the key-switch note to a formatted tool result. Raw JSON output
   * (`json: true`) is never touched — a note appended to JSON would no longer
   * parse, and the switch is a fact about the run, not part of the payload.
   * @param text - the formatted result.
   * @param res - the response the result came from.
   * @param asJson - whether the caller asked for the raw payload.
   * @returns the result, with the note when one applies.
   */
  function withKeyNote(text, res, asJson) {
    return asJson === true ? text : text + keySwitchNote(res)
  }

  /**
   * The reader policy and the endpoint mode stored by the settings card, both
   * re-read per operation (same contract as the API key: a saved change reaches
   * the next call without a restart). settings.js owns the normalization and
   * the defaults, so an unset (or entirely absent) config gets the defaults.
   */
  function toolSettings() {
    try { return toolSettingsOf(settingsSnapshot(settingsConfig)) } catch (err) { return toolSettingsOf(undefined) }
  }

  /** The configured endpoint mode: `'auto' | 'global' | 'cn'`. */
  function endpointMode() {
    return toolSettings().endpoint
  }

  /**
   * The env overlay one attempt needs.
   *
   * The plugin configures no proxy of its own — a CN host is a domestic CDN
   * address and must not ride a VPN — but the harness hands the subprocess a
   * base resolved from the launching environment, which may already carry
   * `HTTP_PROXY` / `HTTPS_PROXY`. The CN side therefore declares its own
   * `NO_PROXY` suffix, merged with whatever this process's environment holds
   * (the same source the seam resolves from); every other attempt inherits the
   * base untouched. Replacing the seam's own list is harmless here: the only URL
   * a CN attempt fetches is a public one, so no bypass entry it might carry can
   * matter.
   *
   * @param side - `'global' | 'cn'`.
   * @returns the `env` overlay, or `undefined` to inherit the seam's base.
   */
  function envForSide(side) {
    if (side !== 'cn') return undefined
    const env = process.env || {}
    return cnBypassEnv(env.NO_PROXY !== undefined ? env.NO_PROXY : env.no_proxy)
  }

  /** One HTTP call through the node helper, on every route settings.js allows. */
  async function jinaRequest(spec) {
    const node = await resolveNode()
    if (!node) return { ok: false, status: 0, text: 'node executable not found on PATH; the helper needs Node.js to make the HTTP call' }
    const kind = spec.kind === 'search' ? 'search' : 'reader'
    // An explicit absolute URL bypasses the endpoint table: only the Jina hosts
    // live there, and `jina_primer` also fetches ipinfo.io.
    const explicit = typeof spec.url === 'string' && spec.url !== ''
    const plan = explicit ? [{ side: null, base: spec.url }] : routePlan(endpointMode(), kind, preferredSide)
    const parse = (r) => {
      // The helper's stdout is capped at MAX_OUT. A body past the cap comes back
      // flagged `lossy`, and JSON.parse on that truncated slice would report a
      // baffling "not parseable" next to a mid-payload snippet. Name the real
      // problem instead, and point at the spilled full body when there is one.
      if (r.stdout.lossy === true) {
        return {
          ok: false,
          status: 0,
          text: 'the Jina response exceeded the transport cap (' + MAX_OUT + ' bytes) and was truncated'
            + (typeof r.stdout.spillPath === 'string' && r.stdout.spillPath !== '' ? '; the full body was spilled to ' + r.stdout.spillPath : '')
            + '. Narrow the request (fewer pages, a target selector, a smaller maxEdge) and retry.',
        }
      }
      let parsed
      try { parsed = JSON.parse(r.stdout.text) } catch (e) {
        return { ok: false, status: 0, text: 'helper output not parseable: ' + String(r.stdout.text).slice(0, 300) + (r.stderr.text ? ' [stderr: ' + String(r.stderr.text).slice(0, 300) + ']' : '') }
      }
      if (typeof parsed !== 'object' || parsed === null) return { ok: false, status: 0, text: 'bad helper output: ' + String(r.stdout.text).slice(0, 300) }
      return parsed
    }
    const tried = []
    let last
    for (const attempt of plan) {
      const payload = JSON.stringify({
        url: attempt.base,
        method: spec.method || 'POST',
        headers: spec.headers || {},
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        timeoutMs: spec.timeoutMs || 60000,
      })
      tried.push(attempt.base)
      const parsed = parse(await runCollect([node, '-e', HTTP_HELPER_SCRIPT], payload, MAX_OUT, envForSide(attempt.side), spec.signal))
      // Anything that answered — a 200, a 422, even a 401 — proves the host is
      // reachable, so that side becomes the preferred one. Only a transport
      // failure (status 0) moves on to the next candidate.
      if (parsed.ok || parsed.status !== 0) {
        // Only a Jina endpoint side is worth remembering; an explicit foreign
        // URL (ipinfo.io) says nothing about which Jina host works.
        if (attempt.side !== null) preferredSide = attempt.side
        return { ...parsed, endpoint: { side: attempt.side, base: attempt.base } }
      }
      last = parsed
    }
    return { ...last, endpoint: { side: null, base: null }, endpointsTried: tried }
  }

  /**
   * Walk one pool until a key serves the call.
   *
   * A failover status (401/402/429) parks that key for its cooldown and moves
   * on; any other failure stops the walk, because rotating cannot help and
   * would spend the rest of the pool on a non-key problem. `tried` dedupes by
   * value, so a key that appears twice in one operation is never requested
   * twice.
   *
   * @param pool - the resolved pool.
   * @param state - the rotation state for that pool.
   * @param attempts - collector for the failed attempts, for the diagnosis.
   * @param tried - the key values already requested in this operation.
   * @param mkRequest - builds one request for a key (the caller's own headers).
   * @returns `{ res, index, fatal }` — the response that settled the walk, and
   *   whether it was a non-failover failure (the walk must not continue).
   */
  async function walkKeyPool(pool, state, attempts, tried, mkRequest) {
    let last
    for (const index of keyRotationOrder(pool.length, state.lastUsed, state.states, Date.now())) {
      const entry = pool[index]
      if (tried.has(entry.value)) continue
      tried.add(entry.value)
      const res = await jinaRequest(mkRequest(entry.value))
      if (res.ok) {
        state.lastUsed = index
        state.states[index] = clearKeyState()
        return { res, index, fatal: false }
      }
      if (!isKeyFailoverStatus(res.status)) return { res, index, fatal: true }
      // A revoked or overdrawn key is discarded, not parked: the user only ever
      // adds keys, the plugin keeps the pool clean. 429 stays (temporary).
      const discarded = res.status === 401 || res.status === 402 ? await discardKey(entry) : false
      attempts.push({ index, status: res.status, entry, discarded })
      state.states[index] = keyStateAfter(state.states[index], res.status, Date.now())
      last = res
    }
    return { res: last, index: -1, fatal: false }
  }

  /**
   * Full call: key pool + auth header + automatic failover.
   *
   * An explicit `apiKey` parameter is the caller's own choice: it is used
   * alone, with no rotation (there is nothing to rotate to). Otherwise the
   * resolved pool is walked, the last successful key leads the next call, and
   * a switch made mid-call is reported on the result as `keySwitch` so the
   * tools can tell the user that a key was overdrawn.
   */
  async function callJina(opts) {
    const headers = {}
    for (const k of Object.keys(opts.headers || {})) headers[k] = opts.headers[k]
    const explicit = opts.apiKey !== undefined && opts.apiKey !== null && opts.apiKey !== ''
    const mk = () => ({ kind: opts.kind, method: opts.method || 'POST', headers, body: opts.body, timeoutMs: opts.timeoutMs, signal: opts.signal })
    if (explicit) {
      headers.Authorization = 'Bearer ' + String(opts.apiKey)
      return jinaRequest(mk())
    }
    const pool = await loadKeyPool()
    if (pool.length === 0) {
      if (opts.needsKey) {
        return { ok: false, status: 401, text: 'Jina API key required for this command. Save one or more keys in the DSH settings page (Plugins → dsh-jina → API key), or put one key per line in ' + KEY_FILE + ' in the session workspace or the dsh home directory. Get a free key at https://jina.ai/?sui=apikey' + (keyDiag ? ' [key lookup: ' + keyDiag + ']' : '') }
      }
      return jinaRequest(mk())
    }
    // The walk reuses the caller's headers and one request shape; only the
    // Authorization header changes between keys.
    const mkKeyRequest = (key) => ({ ...mk(), headers: { ...headers, Authorization: 'Bearer ' + key } })
    const state = keyStateFor(pool)
    const attempts = []
    const tried = new Set()
    let outcome = await walkKeyPool(pool, state, attempts, tried, mkKeyRequest)
    if (outcome.res !== undefined && outcome.res.ok) {
      if (attempts.length > 0) outcome.res.keySwitch = keySwitchOf(pool, attempts, outcome.index)
      return outcome.res
    }
    if (outcome.fatal) return attempts.length > 0 ? { ...outcome.res, keyAttempts: attempts } : outcome.res
    // Every key answered a failover status. Re-read the sources once before
    // giving up: the fix (a corrected credential or key file) may have landed
    // while this call was running, which is the case the old 401 re-read served.
    filePoolCache = { keys: undefined, at: 0 }
    const refreshed = await loadKeyPool()
    if (refreshed.length > 0 && refreshed.some((entry) => !tried.has(entry.value))) {
      const freshState = keyStateFor(refreshed)
      outcome = await walkKeyPool(refreshed, freshState, attempts, tried, mkKeyRequest)
      if (outcome.res !== undefined && outcome.res.ok) {
        if (attempts.length > 0) outcome.res.keySwitch = keySwitchOf(refreshed, attempts, outcome.index)
        return outcome.res
      }
    }
    return outcome.res === undefined ? { ok: false, status: 0, text: 'no API key could be tried' } : { ...outcome.res, keyAttempts: attempts }
  }

  /** The note describing a switch: which keys failed, and which one took over. */
  function keySwitchOf(pool, attempts, index) {
    const failed = attempts.map(keyAttemptLabel).join('；')
    return {
      index,
      message: '已自动切换 API key：' + failed + '，改用 #' + (index + 1) + '（' + keySourceLabel(pool[index]) + '）。可在 Plugins → dsh-jina 卡片里添加新的 key。',
    }
  }

  function describeJinaError(res) {
    const status = res.status || 0
    const body = String(res.text || '').slice(0, 800)
    // 422 is not one thing, so it is routed by the message the Reader sends:
    //   - "with target selector …"  → the CSS selector matched nothing;
    //   - "No content available"    → the page yielded nothing at all;
    //   - "Screenshot of the page is not available" → the page could not be
    //     RENDERED. That last one is the render step the OCR pipeline depends
    //     on, and the same failure comes back as HTTP 200 with fabricated text
    //     on other pages, so it must never be reported as "your arguments are
    //     invalid" — the model would then "fix" perfectly good parameters.
    let hint422 = 'Invalid request parameters.'
    if (/screenshot of the page is not available/i.test(body)) {
      hint422 = 'The Reader could not render this page (screenshot unavailable). Retrying later sometimes works; for a text page prefer the plain extractor over OCR.'
    } else if (/with target selector/i.test(body)) {
      hint422 = 'The target selector matched nothing on this page. Retry with targetSelector: "" to read the whole page.'
    } else if (/no content available/i.test(body)) {
      hint422 = 'The Reader extracted no content from this URL. If a target selector was sent, it may simply match nothing on this page (retry with targetSelector: "").'
    }
    const hints = {
      0: 'No response from any Jina endpoint.',
      401: 'Invalid or expired API key. Fix: update it in the DSH settings page (Jina Tools) or the key file. Get a free key: https://jina.ai/?sui=apikey',
      402: 'API quota exhausted. Fix: top up credits at https://jina.ai/api-dashboard/billing',
      422: hint422,
      429: 'Rate limit hit. Wait a few seconds and retry, or add an API key for higher limits.',
    }
    let msg = 'Jina API error (HTTP ' + status + '). ' + (hints[status] || '')
    // A transport failure is a routing fact, so report the hosts that were
    // actually tried and what the user can do about it. `cn` mode is a single
    // candidate by design: the user pinned that side, so a failure is stated
    // rather than papered over.
    if (status === 0) {
      const tried = Array.isArray(res.endpointsTried) && res.endpointsTried.length > 0 ? res.endpointsTried.join('、') : ''
      const mode = endpointMode()
      msg += tried === '' ? '' : ' 已尝试的接口域名：' + tried + '。'
      msg += mode === 'cn'
        ? '当前「接口域名」固定为国内域名（r.jinaai.cn / s.jinaai.cn），它无响应说明本机网络到国内 CDN 不通；可在插件卡片里改为「自动」或「国际」再试。'
        : '请检查本机网络连通性，或稍后重试；Jina 官方在国内提供 r.jinaai.cn / s.jinaai.cn，可在插件卡片里把「接口域名」固定为「国内」以避免这条链路。'
    }
    if (status >= 500) {
      msg = 'Jina API server error (HTTP ' + status + '). Retry in a moment; status: https://status.jina.ai'
      // Official guidance for the model pipelines: they are serverless, a cold
      // start answers 503, and the vendor says to retry after 30-60 seconds.
      if (status === 503) msg += ' If this call used jina-ocr-v1 (jina_read_pdf), a cold start is the likely cause — the vendor\'s guidance is to retry after 30–60 seconds.'
    }
    // The pool's own account of what it tried: a quota error on a single key
    // reads very differently once the user can see every saved key was tried.
    if (Array.isArray(res.keyAttempts) && res.keyAttempts.length > 0) {
      const tried = res.keyAttempts.map(keyAttemptLabel).join('；')
      msg += '\nAPI key 轮换：已依次尝试 ' + res.keyAttempts.length + ' 个 key —— ' + tried + '。'
        + (res.keyAttempts.length > 1 ? '所有已保存的 key 都已尝试。' : '')
        + '修复：在 Plugins → dsh-jina 卡片里添加可用的 key（https://jina.ai/?sui=apikey），或为已耗尽的账号充值（https://jina.ai/api-dashboard/billing）。'
    }
    if (body) msg += '\nServer said: ' + body
    return msg
  }

  /**
   * Statuses where the model must change its call or its credential: these
   * throw so the harness marks the result `isError: true` — the only shape
   * that reliably stops the model from treating the payload as data.
   * Environmental / transient statuses (0 network, 402 quota, 429 rate limit,
   * 5xx) stay returned: their hint tells the model to relay the problem to the
   * user or retry, not to "fix" its own arguments.
   */
  const FATAL_JINA_STATUSES = new Set([401, 422])

  /** Turn a failed response into an error (fatal status) or a returned hint. */
  function failJina(res) {
    const message = describeJinaError(res)
    if (FATAL_JINA_STATUSES.has(res.status || 0)) throw new Error(message)
    return message
  }

  /** Per-call session workspace + signal; run at the top of every execute. */
  const enterExec = (exec) => {
    const cwd = sessionCwdOf(exec)
    if (cwd !== undefined) currentCwd = cwd
    return (exec && exec.signal) || undefined
  }

  /**
   * Format one search payload.
   *
   * `s.jina.ai` and its mainland mirror answer
   * `{ code, status, data: [{ title, url, description, date }] }` — so the
   * snippet field is `description`, not the `snippet` the old `svip.jina.ai`
   * host used. Both shapes are accepted (the older one keeps working for a
   * payload that predates the move), and anything unrecognized is returned
   * verbatim rather than silently swallowed.
   */
  function fmtSearch(text, asJson) {
    if (asJson) return text
    let data
    try { data = JSON.parse(text) } catch (e) { return text }
    const results = Array.isArray(data && data.data)
      ? data.data
      : (data && Array.isArray(data.results) ? data.results : undefined)
    if (results === undefined) return text
    if (results.length === 0) return '(no results)'
    const lines = []
    for (const r of results) {
      if (r && typeof r === 'object') {
        lines.push(String(r.title || '(untitled)'))
        if (r.url) lines.push('  ' + String(r.url))
        const snippet = r.description || r.snippet
        if (snippet) lines.push('  ' + String(snippet))
        if (r.date) lines.push('  ' + String(r.date))
      } else {
        lines.push(String(r))
      }
      lines.push('')
    }
    return lines.join('\n').trim()
  }

  function fmtDatetime(text, asJson) {
    if (asJson) return text
    try {
      const data = JSON.parse(text)
      const d = data && typeof data === 'object' ? (data.data || data) : data
      if (d && typeof d === 'object') {
        const lines = []
        if (typeof d.title === 'string' && d.title.length > 0) lines.push('title: ' + d.title)
        if (typeof d.description === 'string' && d.description.length > 0 && d.description !== d.title) lines.push('description: ' + String(d.description).slice(0, 200))
        const times = []
        const mk = d.metadata && typeof d.metadata === 'object' ? d.metadata : {}
        for (const k of ['publishedTime', 'article:published_time', 'bytedance:published_time', 'article:modified_time', 'bytedance:updated_time']) {
          const v = typeof mk[k] === 'string' ? mk[k] : (typeof d[k] === 'string' ? d[k] : undefined)
          if (v !== undefined && v.length > 0) times.push(k + ': ' + v)
        }
        if (times.length > 0) lines.push(times.join(' | '))
        if (typeof d.url === 'string' && d.url.length > 0) lines.push('url: ' + d.url)
        if (lines.length > 0) return lines.join('\n')
      }
    } catch (e) { /* fall through */ }
    return text
  }

  function fmtScreenshot(text) {
    try {
      const data = JSON.parse(text)
      const d = data && typeof data === 'object' ? (data.data || data) : data
      if (d && typeof d === 'object') {
        const u = d.screenshotUrl || d.pageshotUrl || d.url
        if (typeof u === 'string' && u.length > 0) return 'screenshot URL: ' + u
        const b64 = d.screenshot || d.image
        if (typeof b64 === 'string' && b64.length > 0) return 'screenshot returned as embedded base64 image data (' + b64.length + ' chars)'
      }
    } catch (e) { /* fall through */ }
    return text
  }

  // ---- tool registration ---------------------------------------------------
  // IMPORTANT: `tools.register` forwards `parameters` verbatim to the model API.
  // It must therefore be a full JSON Schema object ({ type: 'object',
  // properties, required, additionalProperties }) — NOT the defineTool-style
  // per-property map ({ field: { type, required: true } }), which the model
  // server rejects ("schema must be a JSON Schema of 'type: \"object\"'").
  const OUT = {
    schema: { type: 'string' },
    render(_args, value) { return [{ type: 'text', text: value }] },
  }

  /** Read one key from arguments the model may have sent as anything at all. */
  const argAt = (args, key) => (args !== null && typeof args === 'object' ? args[key] : undefined)

  /** The keys the model actually sent, for an argument-error message. */
  function argsReceived(args) {
    if (args === null || typeof args !== 'object') return args === undefined ? 'nothing' : typeof args
    const keys = Object.keys(args)
    return keys.length === 0 ? 'no arguments' : keys.join(', ')
  }

  /**
   * Reject a missing or blank required string argument before it reaches the API.
   *
   * `ctx.tools.register` forwards `parameters` to the model API but never
   * enforces it — only the first-party `defineTool` path runs the argument
   * validator — so a key the model got wrong arrives here untouched. Without
   * this guard `String(args.query)` quietly turns a missing query into the
   * search term `undefined`, and Jina dutifully answers with MDN's `undefined`
   * page: a well-formed, `isError: false` result that reads exactly like a real
   * search (observed live — the model had sent `queries` instead of `query`).
   *
   * Throwing (rather than returning an error string) is deliberate: only a
   * thrown error becomes `isError: true`, the one shape that reliably stops the
   * model from treating junk as data.
   * @param name - tool name, quoted into the message.
   * @param args - raw model arguments.
   * @param key - the required property name.
   * @param aliases - names a caller may have used by mistake, reported as a hint.
   * @returns nothing when the value is a non-blank string; otherwise throws.
   */
  function requireStringArg(name, args, key, aliases) {
    const value = argAt(args, key)
    if (typeof value === 'string' && value.trim() !== '') return
    const got = value === undefined ? 'nothing' : '(' + typeof value + ') ' + JSON.stringify(value)
    const typo = (aliases || []).find((alias) => argAt(args, alias) !== undefined)
    throw new Error('invalid arguments: ' + name + ' requires a non-empty "' + key + '" string, but got ' + got
      + (typo === undefined ? '' : ' — did you mean "' + key + '" instead of "' + typo + '"?')
      + ' (arguments received: ' + argsReceived(args) + ')')
  }

  /**
   * Reject a missing or non-http(s) required URL argument.
   * Same contract and same reasoning as {@link requireStringArg}: a returned
   * string is a *successful* result the model may read as data, so an argument
   * the model got wrong must throw instead.
   * @param name - tool name, quoted into the message.
   * @param args - raw model arguments.
   * @param key - the required property name.
   * @param aliases - names a caller may have used by mistake, reported as a hint.
   * @returns nothing when the value is an http(s) URL string; otherwise throws.
   */
  function requireUrlArg(name, args, key, aliases) {
    const value = argAt(args, key)
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return
    const got = value === undefined ? 'nothing' : '(' + typeof value + ') ' + JSON.stringify(value)
    const typo = (aliases || []).find((alias) => argAt(args, alias) !== undefined)
    throw new Error('invalid arguments: ' + name + ' requires an http(s) "' + key + '" string, but got ' + got
      + (typo === undefined ? '' : ' — did you mean "' + key + '" instead of "' + typo + '"?')
      + ' (arguments received: ' + argsReceived(args) + ')')
  }

  /** Shared executor for the search tools (jina_web_search / jina_search_arxiv / jina_search_ssrn). */
  async function runSearch(args, exec, fixedType) {
    const name = fixedType === 'arxiv' ? 'jina_search_arxiv' : fixedType === 'ssrn' ? 'jina_search_ssrn' : 'jina_web_search'
    requireStringArg(name, args, 'query', ['queries', 'q'])
    const signal = enterExec(exec)
    const body = { q: String(args.query) }
    const t = fixedType || args.type
    // The academic shortcuts used to ride `svip.jina.ai`'s `domain` field. The
    // `s.jina.ai` endpoint (and its mainland mirror) ignores `domain` but
    // honours `site` — verified against both hosts — so the restriction moved
    // to the field that actually survives the route change.
    if (t === 'arxiv') body.site = 'arxiv.org'
    else if (t === 'ssrn') body.site = 'ssrn.com'
    else if (t === 'images') body.type = 'images'
    else if (t === 'blog') body.q = 'site:jina.ai/news ' + String(args.query)
    if (args.num !== undefined) body.num = args.num
    if (args.time) body.tbs = 'qdr:' + args.time
    if (args.location) body.location = args.location
    if (args.gl) body.gl = args.gl
    if (args.hl) body.hl = args.hl
    const res = await callJina({
      kind: 'search', method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body, timeoutMs: 60000, needsKey: true, apiKey: args.apiKey, signal,
    })
    if (!res.ok) return failJina(res)
    return withKeyNote(fmtSearch(res.text, args.json === true), res, args.json === true)
  }

  ctx.tools.register({
    ...WEB_SEARCH_TOOL,
    output: OUT,
    async execute(args, exec) {
      return runSearch(args, exec)
    },
  })

  ctx.tools.register({
    name: 'jina_search_arxiv',
    description: 'Search academic papers and preprints on arXiv via Jina. Use this whenever the user asks for computer science, machine learning, mathematics, physics or other quantitative research papers, surveys or preprints. Results are canonical arxiv.org paper links with accurate snippets.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search query: paper title, topic or keywords.' },
        num: { type: 'number', description: 'Number of results. Default: 5.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of formatted results.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['query'],
    },
    output: OUT,
    async execute(args, exec) {
      return runSearch(args, exec, 'arxiv')
    },
  })

  ctx.tools.register({
    name: 'jina_search_ssrn',
    description: 'Search academic papers on SSRN (Social Science Research Network) via Jina. Use this whenever the user asks for economics, finance, law, management or other social-science working papers and publications. Results are canonical papers.ssrn.com links with accurate snippets.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search query: paper title, topic or keywords.' },
        num: { type: 'number', description: 'Number of results. Default: 5.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of formatted results.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['query'],
    },
    output: OUT,
    async execute(args, exec) {
      return runSearch(args, exec, 'ssrn')
    },
  })

  /**
   * Unwrap a Reader JSON payload.
   *
   * Every read now asks for `Accept: application/json` — that is what carries
   * the title, the post-redirect URL and the token usage. A shape surprise must
   * never lose the body, so an unparsable response comes back as `content`.
   */
  function readPayload(text) {
    const raw = typeof text === 'string' ? text : ''
    try {
      const parsed = JSON.parse(raw)
      const d = parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed
      if (d && typeof d === 'object') {
        return {
          title: typeof d.title === 'string' ? d.title : '',
          url: typeof d.url === 'string' ? d.url : '',
          published: typeof d.publishedTime === 'string' ? d.publishedTime : '',
          content: typeof d.content === 'string' ? d.content : '',
        }
      }
    } catch (err) { /* not JSON — fall through to the raw body */ }
    return { title: '', url: '', published: '', content: raw }
  }

  /** Token accounting, appended when the payload reports usage. */
  function usageFooter(text) {
    try {
      const parsed = JSON.parse(text)
      const usage = (parsed && parsed.usage) || (parsed && parsed.data && parsed.data.usage)
      if (usage && typeof usage === 'object') {
        const parts = Object.keys(usage)
          .filter((k) => typeof usage[k] === 'number')
          .map((k) => k + '=' + usage[k])
        if (parts.length > 0) return '\n\n[Usage: ' + parts.join(', ') + ']'
      }
    } catch (err) { /* nothing to report */ }
    return ''
  }

  /** jina-ocr-v1's documented output cap (`max_new_tokens=4096`). */
  const OCR_OUTPUT_CAP = 4096
  /** Pages a bare `jina_read_pdf` call covers before the caller asks for more. */
  const PDF_DEFAULT_PAGES = 5
  /** Hard ceiling on `maxPages`: one call must not be able to drain an account. */
  const PDF_MAX_PAGES = 50

  /** Whether a URL looks like a PDF (path ends in `.pdf`, ignoring query/hash). */
  function isPdfUrl(value) {
    const raw = String(value === undefined || value === null ? '' : value).trim()
    if (raw === '') return false
    let path = raw
    try { path = new URL(raw).pathname } catch (err) { path = raw.split(/[?#]/)[0] }
    return /\.pdf$/i.test(path)
  }

  /** Whether a 422 body says the target selector matched nothing. */
  function selectorMismatch(res) {
    return /with target selector/i.test(String(res && res.text !== undefined ? res.text : ''))
  }

  /**
   * The page numbers one `jina_read_pdf` call reads.
   *
   * `spec` is 1-indexed and accepts `3`, `1-5` or `2,4,7`. Anything unparsable
   * falls back to the default range instead of throwing — a model that wrote
   * "pages 1 to 3" should still get its pages.
   */
  function planPages(spec, maxPages) {
    const wanted = Number(maxPages)
    const cap = Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.floor(wanted), PDF_MAX_PAGES) : PDF_DEFAULT_PAGES
    const pages = []
    const push = (n) => {
      if (Number.isInteger(n) && n >= 1 && n <= PDF_MAX_PAGES && pages.indexOf(n) === -1) pages.push(n)
    }
    if (typeof spec === 'string' && spec.trim() !== '') {
      for (const part of spec.split(',')) {
        const piece = part.trim()
        if (piece === '') continue
        const range = piece.match(/^(\d+)\s*[-–~]\s*(\d+)$/)
        if (range) {
          for (let n = Number(range[1]); n <= Number(range[2]) && pages.length < PDF_MAX_PAGES; n++) push(n)
          continue
        }
        push(Number(piece))
      }
    }
    if (pages.length === 0) for (let n = 1; n <= cap; n++) push(n)
    return pages.sort((a, b) => a - b)
  }

  /** The numeric `usage` object one Reader payload reports, or undefined. */
  function readerUsage(text) {
    try {
      const parsed = JSON.parse(text)
      const usage = (parsed && parsed.usage) || (parsed && parsed.data && parsed.data.usage)
      if (usage !== null && typeof usage === 'object') return usage
    } catch (err) { /* not JSON */ }
    return undefined
  }

  /**
   * The provenance marker a generative pipeline earns.
   *
   * `jina-ocr-v1` does not extract text — it *produces* it, so its output can
   * silently differ from the page (measured: the same arXiv paper came back
   * correct as a PDF and wholly fabricated as HTML). Saying so inside the
   * result is the cheapest guard there is: the model reading it can choose to
   * verify instead of quoting it as fact.
   */
  function pipelineNote(pipeline) {
    if (pipeline === 'jina-ocr-v1') {
      return '\n\n[Reader pipeline: jina-ocr-v1 — a generative document model transcribed this page image. Numbers, names and tables can be misread or invented; verify anything load-bearing against the source.]'
    }
    return ''
  }

  ctx.tools.register({
    name: 'jina_read',
    description: 'Read a web page as clean markdown via Jina Reader, mirroring the jina-cli \'read\' command. Uses the vendor\'s `agent` preset, resolves relative links against the post-redirect URL, and strips page chrome by default. Works without an API key (rate-limited). For a scanned / image-only PDF use jina_read_pdf; for a PDF with a text layer this tool is the cheaper and verbatim path.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Page URL, starting with http:// or https://.' },
        targetSelector: { type: 'string', description: 'CSS selector(s) to keep instead of the whole page (overrides the configured default list).' },
        waitForSelector: { type: 'string', description: 'CSS selector to wait for before extracting (dynamically rendered pages).' },
        removeSelector: { type: 'string', description: 'CSS selector(s) to drop before extracting (overrides the configured default list).' },
        noCache: { type: 'boolean', description: 'Bypass the Jina cache and fetch the page fresh.' },
        links: { type: 'boolean', description: 'Include hyperlinks in the output.' },
        images: { type: 'boolean', description: 'Include image summaries in the output.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of the extracted markdown.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['url'],
    },
    output: OUT,
    async execute(args, exec) {
      requireUrlArg('jina_read', args, 'url', ['uri', 'link', 'href'])
      const signal = enterExec(exec)
      const defaults = toolSettings()
      const key = args.apiKey || await loadKey()
      // Alt-text generation is key-gated: supplying a key is what makes a read
      // billable, so it is sent only when the user opted in AND a key exists.
      const useAltText = defaults.autoAltText === true && key !== undefined
      const selectorsOn = defaults.useSelectors !== false

      /** Build one request's headers; the fallback flips `withSelectors` off. */
      const buildHeaders = (withSelectors) => {
        const headers = {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Md-Link-Style': 'discarded',
          'X-Preset': READER_PRESET,
          'X-Base': READER_BASE,
          'X-Timeout': String(READER_TIMEOUT_SECONDS),
          'X-Retain-Images': defaults.imagePolicy,
        }
        if (args.links) headers['X-With-Links-Summary'] = 'all'
        if (args.images) headers['X-With-Images-Summary'] = 'true'
        if (useAltText) headers['X-With-Generated-Alt'] = 'true'
        if (args.noCache) headers['X-No-Cache'] = 'true'
        if (withSelectors) {
          // An explicitly empty `targetSelector` means "read the whole page" —
          // the advice the 422 hint gives. Only an *unset* argument falls back
          // to the configured list and then to the built-in one.
          const target = args.targetSelector === undefined
            ? (defaults.targetSelector || DEFAULT_TARGET_SELECTORS)
            : String(args.targetSelector).trim()
          const wait = args.waitForSelector || defaults.waitForSelector
          const remove = args.removeSelector || defaults.removeSelector || DEFAULT_REMOVE_SELECTORS
          if (target !== '') {
            headers['X-Target-Selector'] = target
            // The implied `X-Wait-For-Selector` must not outlive the client
            // ceiling, or a selector that never appears turns into a transport
            // timeout (see settings.js).
            headers['X-Timeout'] = String(SELECTOR_WAIT_TIMEOUT_SECONDS)
          }
          if (wait !== '') headers['X-Wait-For-Selector'] = wait
          if (remove !== '') headers['X-Remove-Selector'] = remove
        }
        return headers
      }

      const request = (headers, timeoutMs) => callJina({
        method: 'POST', headers,
        body: { url: String(args.url) }, timeoutMs,
        needsKey: useAltText, apiKey: args.apiKey, signal,
      })

      // The selector attempt runs on the short patience/ceiling pair; a read of
      // the whole page keeps the full budget for heavy pages.
      const firstHeaders = buildHeaders(selectorsOn)
      const withTarget = firstHeaders['X-Target-Selector'] !== undefined
      let res = await request(firstHeaders, withTarget ? SELECTOR_ATTEMPT_TIMEOUT_MS : READ_TIMEOUT_MS)
      let content = res.ok ? readPayload(res.text).content : ''

      // The target-selector group is a default, never a trap. Three shapes of
      // "it did not match" all fall back to the whole page:
      //   - a short body (it matched a tiny container),
      //   - 422 with the selector named in the message,
      //   - no answer at all (the implied wait outlived the client ceiling).
      const selectorFallback = withTarget && (!res.ok
        ? res.status === 0 || (res.status === 422 && selectorMismatch(res))
        : content.length < SELECTOR_RETRY_MIN_CHARS)
      if (selectorFallback) {
        const retry = await request(buildHeaders(false), READ_TIMEOUT_MS)
        const retryContent = retry.ok ? readPayload(retry.text).content : ''
        // A failure is replaced by any success; a short body only by a longer one.
        if (retry.ok && (res.ok === false || retryContent.length > content.length)) {
          res = retry
          content = retryContent
        }
      }
      if (!res.ok) return failJina(res)
      if (args.json) return res.text
      if (content === '') return res.text
      const payload = readPayload(res.text)
      let out = content
      if (payload.title !== '' && out.indexOf(payload.title) === -1) {
        out = 'Title: ' + payload.title
          + '\nURL Source: ' + (payload.url !== '' ? payload.url : String(args.url))
          + (payload.published !== '' ? '\nPublished Time: ' + payload.published : '')
          + '\n\nMarkdown Content:\n' + out
      }
      return out + usageFooter(res.text) + keySwitchNote(res)
    },
  })

  ctx.tools.register({
    name: 'jina_read_pdf',
    description: 'Read a PDF as Markdown through jina-ocr-v1, Jina\'s 3.4B document-OCR model — the pipeline that works on scanned / image-only PDFs, where jina_read returns almost nothing. The Reader renders each page to an image and the model transcribes it, so pages are requested ONE AT A TIME (the API silently serves page 1 again when asked for a page past the end, which is how this tool detects the end). Try jina_read first: a PDF with a text layer is verbatim and ~40x cheaper there. Costs ~40x the plain extractor\'s tokens.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'PDF URL (https). Must look like a PDF unless allowNonPdf is set.' },
        pages: { type: 'string', description: 'Pages to read, 1-indexed: "3", "1-5" or "2,4,7". Default: the first maxPages pages.' },
        maxPages: { type: 'number', description: 'How many pages the default range covers. Default: 5. Hard cap: 50.' },
        allowNonPdf: { type: 'boolean', description: 'Read a URL that does not look like a PDF anyway. OCR on ordinary web pages can fabricate content — prefer jina_read there.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['url'],
    },
    output: OUT,
    async execute(args, exec) {
      requireUrlArg('jina_read_pdf', args, 'url', ['uri', 'link', 'href'])
      const signal = enterExec(exec)
      const url = String(args.url)
      if (!isPdfUrl(url) && args.allowNonPdf !== true) {
        throw new Error('jina_read_pdf expects a PDF URL: "' + url + '" does not end in .pdf. '
          + 'jina-ocr-v1 is a document model — it reads one rendered page image per call, and on ordinary web pages it is known to invent text it cannot read. '
          + 'Use jina_read for web pages, or pass allowNonPdf: true if this URL really is a PDF.')
      }
      const key = args.apiKey || await loadKey()
      if (!key) {
        throw new Error('jina_read_pdf requires a Jina API key: the Reader rejects jina-ocr-v1 for anonymous callers (HTTP 401, '
          + '"Authentication is required to use this feature (Vision Language Model / OCR)"). '
          + 'Save a key in the Plugins → dsh-jina card, or pass apiKey.')
      }
      const defaults = toolSettings()
      const pages = planPages(args.pages, args.maxPages)
      const sections = []
      const warnings = []
      const seen = new Map()
      let title = ''
      let source = url
      let stopped = ''
      let scaled = 0
      let switchNote = ''
      for (const page of pages) {
        const res = await callJina({
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Md-Link-Style': 'discarded',
            'X-Preset': READER_PRESET,
            'X-Base': READER_BASE,
            'X-Timeout': String(READER_TIMEOUT_SECONDS),
            'X-Retain-Images': defaults.imagePolicy,
            'X-Respond-With': 'jina-ocr-v1',
            'X-Page': String(page),
          },
          body: { url }, timeoutMs: 120000, needsKey: true, apiKey: args.apiKey, signal,
        })
        if (!res.ok) {
          // A first page that fails is the whole call failing; a later page that
          // fails only truncates the result, so keep what was read and say so.
          if (sections.length === 0) return failJina(res)
          warnings.push('page ' + page + ': ' + describeJinaError(res).split('\n')[0])
          stopped = 'page ' + page + ' failed'
          break
        }
        switchNote = switchNote || keySwitchNote(res)
        const payload = readPayload(res.text)
        if (title === '' && payload.title !== '') title = payload.title
        if (payload.url !== '') source = payload.url
        const usage = readerUsage(res.text)
        if (usage && typeof usage.scaledTokens === 'number') scaled += usage.scaledTokens
        const text = payload.content.trim()
        if (text === '' || text.toLowerCase() === 'null') {
          stopped = 'page ' + page + ' came back empty'
          break
        }
        const fingerprint = text.replace(/\s+/g, ' ').slice(0, 4000)
        if (seen.has(fingerprint)) {
          // Verified against the live API: an out-of-range X-Page silently
          // returns page 1 again, so a repeat is the end-of-document signal.
          stopped = 'page ' + page + ' repeated page ' + seen.get(fingerprint) + ' (past the end of the document)'
          break
        }
        seen.set(fingerprint, page)
        if (usage && usage.outputTokens === OCR_OUTPUT_CAP) {
          warnings.push('page ' + page + ' hit the model output cap (' + OCR_OUTPUT_CAP + ' tokens): it may be truncated, or a degenerate repetition')
        }
        sections.push('## Page ' + page + '\n\n' + text)
      }
      if (sections.length === 0) return '(no page could be read)'
      const head = (title !== '' ? 'Title: ' + title + '\n' : '') + 'URL Source: ' + source + '\n\n'
      const meta = '[jina_read_pdf: ' + sections.length + ' page(s) via jina-ocr-v1'
        + (scaled > 0 ? ', ' + scaled + ' tokens billed' : '')
        + (stopped !== '' ? '; stopped because ' + stopped : '')
        + ']'
      const tail = warnings.length > 0 ? '\n\n[Warnings]\n' + warnings.map((w) => '- ' + w).join('\n') : ''
      return head + meta + '\n\n' + sections.join('\n\n') + pipelineNote('jina-ocr-v1') + tail + switchNote
    },
  })

  ctx.tools.register({
    name: 'jina_screenshot',
    description: 'Capture a screenshot of a web page via Jina (r.jina.ai), mirroring the jina-cli \'screenshot\' command. Returns the hosted screenshot URL.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Page URL, starting with http:// or https://.' },
        fullPage: { type: 'boolean', description: 'Capture the full page instead of the viewport.' },
        apiKey: { type: 'string', description: 'Optional Jina API key override.' },
      },
      required: ['url'],
    },
    output: OUT,
    async execute(args, exec) {
      requireUrlArg('jina_screenshot', args, 'url', ['uri', 'link', 'href'])
      const signal = enterExec(exec)
      const res = await callJina({
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Return-Format': args.fullPage ? 'pageshot' : 'screenshot' },
        body: { url: String(args.url) }, timeoutMs: 120000, needsKey: true, apiKey: args.apiKey, signal,
      })
      if (!res.ok) return failJina(res)
      return fmtScreenshot(res.text) + keySwitchNote(res)
    },
  })

  ctx.tools.register({
    name: 'jina_datetime',
    description: 'Guess the publish/update datetime of a URL via Jina Reader, mirroring the jina-cli \'datetime\' command. Works without an API key.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Page URL, starting with http:// or https://.' },
        json: { type: 'boolean', description: 'Return the raw JSON response instead of the extracted title/datetime.' },
      },
      required: ['url'],
    },
    output: OUT,
    async execute(args, exec) {
      requireUrlArg('jina_datetime', args, 'url', ['uri', 'link', 'href'])
      const signal = enterExec(exec)
      const res = await callJina({
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Return-Format': 'datetime' },
        body: { url: String(args.url) }, timeoutMs: 60000, needsKey: false, signal,
      })
      if (!res.ok) return failJina(res)
      return withKeyNote(fmtDatetime(res.text, args.json === true), res, args.json === true)
    },
  })

  ctx.tools.register({
    name: 'jina_primer',
    description: 'Get current context for time/location-aware answers: host clock (ISO time, unix, timezone, UTC offset), network facts (public IP and location, best-effort via ipinfo.io), and Jina account status (authenticated identity + credit balance from r.jina.ai). Sections that cannot be fetched are reported as unavailable; the tool never throws. Works without an API key.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        json: { type: 'boolean', description: 'Return the raw JSON data object instead of formatted text.' },
      },
    },
    output: OUT,
    async execute(args, exec) {
      const signal = enterExec(exec)
      const now = new Date()
      // Best-effort parallel probes; one failing section must not fail the tool.
      const [jinaRes, ipRes] = await Promise.all([
        callJina({
          method: 'GET',
          headers: { Accept: 'application/json' },
          body: undefined, timeoutMs: 60000, needsKey: false, signal,
        }),
        jinaRequest({
          url: IPINFO, method: 'GET',
          headers: { Accept: 'application/json' },
          body: undefined, timeoutMs: 10000, signal,
        }),
      ])
      const jina = jinaRes && jinaRes.ok ? parseJinaRoot(jinaRes.text) : null
      const network = ipRes && ipRes.ok ? parseIpInfo(ipRes.text) : null
      return formatPrimer(buildPrimer({ now, jina, network }), args.json === true)
    },
  })

  // ---- web settings health-check endpoint -----------------------------------
  // The Jina Tools card asks this route how many keys it holds and how many can
  // serve a call, plus the total credits behind them (jina-cli `primer`), and
  // which endpoint side answered. Registered when the deployment composes a
  // web server (the web profile); profiles without one simply never get the
  // route. Nothing per key leaves the host: the payload carries counts and one
  // total, never a key, its fingerprint, or its individual balance — and a key
  // that answers 401/402 or reports no credits left is discarded here, so the
  // page never has to offer the user a list to manage.

  /**
   * Probe one key against the Reader root — the same call jina-cli `primer`
   * makes. One key, one request, no rotation: the card must learn what each
   * key answers, so the pool walk would be exactly the wrong tool here.
   * @param key - the key value, or undefined for the anonymous probe.
   * @param signal - optional cancellation.
   * @returns the transport result.
   */
  function probeKey(key, signal) {
    const headers = { Accept: 'application/json' }
    if (key !== undefined && key !== null && key !== '') headers.Authorization = 'Bearer ' + String(key)
    return jinaRequest({ method: 'GET', headers, body: undefined, timeoutMs: 30000, signal })
  }

  /**
   * The identity and balance a primer response carries.
   * @param text - the raw response body.
   * @returns `{ parsed, authenticatedAs, balanceLeft }` — `parsed` is false
   *   when the body was not the expected JSON shape.
   */
  function primerData(text) {
    try {
      const data = JSON.parse(text)
      const d = (data && typeof data === 'object' && data.data && typeof data.data === 'object') ? data.data : data
      return {
        parsed: true,
        authenticatedAs: d !== null && typeof d === 'object' && typeof d.authenticatedAs === 'string' ? d.authenticatedAs : '',
        balanceLeft: d !== null && typeof d === 'object' && typeof d.balanceLeft === 'number' ? d.balanceLeft : null,
      }
    } catch (err) {
      return { parsed: false, authenticatedAs: '', balanceLeft: null }
    }
  }

  ctx.inject(['webServer'], (rpcCtx) => {
    rpcCtx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-jina/primer',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { Allow: 'GET' })
          res.end()
          return
        }
        const pool = await loadKeyPool()
        const state = keyStateFor(pool)
        // One probe per key, in parallel: this is where the pool is kept clean.
        const probes = await Promise.all(pool.map((entry) => probeKey(entry.value)))
        const discarded = []
        const survived = []
        const counts = { keyCount: 0, balanceTotal: null }
        await Promise.all(pool.map(async (entry, index) => {
          const probe = probes[index]
          const ok = probe.ok === true
          const data = ok ? primerData(probe.text) : { authenticatedAs: '', balanceLeft: null }
          // A key that cannot serve a call is deleted, not listed: 401, 402, or
          // a healthy-looking probe that reports no credits left. Anything else
          // (a rate limit, a network failure) only parks it for a cooldown —
          // discarding a working key over a transient failure would be wrong.
          const exhausted = ok && typeof data.balanceLeft === 'number' && data.balanceLeft <= 0
          const doomed = !ok ? (probe.status === 401 || probe.status === 402) : exhausted
          if (doomed && await discardKey(entry)) discarded.push(entry)
          survived[index] = !doomed
          if (!doomed) counts.keyCount++
          if (!doomed && typeof data.balanceLeft === 'number') {
            counts.balanceTotal = (counts.balanceTotal === null ? 0 : counts.balanceTotal) + data.balanceLeft
          }
          // The card's refresh is also a health check: a key that answers here
          // updates the same rotation state the failover walk uses, so topping
          // an account up clears its cooldown without a restart.
          state.states[index] = ok ? clearKeyState() : keyStateAfter(state.states[index], probe.status, Date.now())
        }))
        // The headline probe answers "can this profile reach Jina at all" and
        // must describe a key that is still there: the first surviving key whose
        // probe worked, else the first surviving key, else — nothing left — the
        // anonymous probe.
        const okIndex = probes.findIndex((probe, index) => survived[index] === true && probe.ok === true)
        const outIndex = okIndex >= 0 ? okIndex : survived.indexOf(true)
        const out = outIndex >= 0 ? probes[outIndex] : await probeKey(undefined)
        const probed = outIndex < 0 ? undefined : pool[outIndex]
        // The page shows the pool size and one total, never anything per key and
        // never a usable/total fraction — the host discards what cannot serve a
        // call, so the count it reports is the count that matters.
        // `balanceTotal` is null when no key reported a balance, so the page can
        // say "unknown" instead of "0".
        const extra = {
          // Which host pair answered, and what the card has configured. The card
          // uses this to show the live route, so a user who pinned the wrong
          // side sees it before the model reports a transport failure.
          endpoint: {
            mode: endpointMode(),
            side: out.endpoint === undefined ? null : out.endpoint.side,
            base: out.endpoint === undefined ? null : out.endpoint.base,
          },
          settingsLive: settingsAreLive(settingsConfig),
          keyCount: counts.keyCount,
          balanceTotal: counts.balanceTotal,
          discardedCount: discarded.length,
        }
        let payload
        if (out.ok) {
          const data = primerData(out.text)
          payload = data.parsed
            ? {
                ok: true,
                status: out.status,
                authenticatedAs: data.authenticatedAs,
                balanceLeft: data.balanceLeft,
                keyFound: probed !== undefined,
                keyKind: probed === undefined ? undefined : (probed.source === 'credential' ? 'credential' : 'file'),
                ...extra,
              }
            : { ok: false, status: out.status, error: 'unexpected primer response shape', ...extra }
        } else {
          payload = { ok: false, status: out.status, error: describeJinaError(out), ...extra }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(payload))
      },
    })
  })

  // ---- web settings namespace ------------------------------------------------
  // There is nothing to register at runtime: the `jina-tools` settings
  // namespace *is* this Loader entry (the bundle's `cordis.patch.yml` contributes
  // `- id: jina-tools / name: dsh-jina`), and the module-level `Config` export
  // above is the live-field declaration the settings provider serves to the
  // browser half's configuration form. `apply` receives the resolved config (see
  // `settingsConfig`) and the loader writes a saved field straight into its
  // volatile references, so a save reaches the next operation without a restart.
  //
  // The stored document only ever holds what the user changed — defaults live in
  // settings.js (`toolSettingsOf`) so "unset" keeps meaning "default" and a later
  // default change reaches users who never touched the field.
}
