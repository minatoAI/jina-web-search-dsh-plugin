**English** | [简体中文](README.md)

# dsh-jina

A [Jina AI](https://jina.ai/) plugin (bundle) for DeepSeek Harness: it exposes the full jina-cli API surface to the model as tool calls, and adds a configuration form on the Web **Plugins** page (on the `dsh-jina` bundle card) for your API key and a **local proxy address**; on older harnesses the same card falls back to **Settings → Plugins → Configure**.

## Changelog

> Only the latest release is listed here; the full version history lives in [change-log.en.md](./change-log.en.md).

### 0.8.0 (2026-09-18)

- **feat** **`jina_read` gains an OCR switch (jina-ocr-v1)**: with `ocr: true`, or as a card default, reads go through the vendor's 3.4B document parser — a scanned page, image-heavy PDF or formula/table-heavy document becomes Markdown in one pass (tables as HTML, formulas as LaTeX). Multi-page documents can be steered with `page`. It costs roughly **40x the tokens** and **requires an API key** (the Reader answers anonymous callers with 401), so the plugin **sends no request** without a key and returns an actionable message instead.
- **feat** **Three zero-side-effect parameters on every read**: `X-Preset: agent` (the vendor's agent preset — the docs state a preset only fills options the caller did not set explicitly), `X-Base: final` (resolve relative links against the post-redirect URL), `X-Timeout: 120` (a slow-page safety net matched to the client's own 120 s ceiling).
- **feat** **Selector group on by default with an automatic fallback**: conservative target/remove selectors plus new per-call parameters `targetSelector`, `waitForSelector`, `removeSelector` and `noCache`; a result shorter than 200 characters is **retried without the selector group** so a non-matching selector can never yield an empty page.
- **feat** **Image policy back to the API default `all`** (with `alt` / `none` selectable), and a new "reader options" block on the card (OCR, image policy, alt text, selector group, selector overrides) sharing one revision-fenced write path with `proxyUrl`.
- **fix** `X-With-Generated-Alt` is now **off by default**: it needs a key, is mutually exclusive with OCR, and — because supplying a key is what makes a read billable — defaulting it on would silently turn free anonymous reads into charged ones.
- **fix** `createSettingsSchema()` used to keep only `proxyUrl`, silently dropping any new field; it now keeps every known field, and `toolSettingsOf()` resolves "unset" into the documented defaults (the document still stores deviations only).
- **fix** **A required argument is no longer silently coerced into `"undefined"`**: `ctx.tools.register` does not validate arguments at runtime, so when the model used the wrong key (e.g. the built-in `web_search`'s `queries` instead of this plugin's `query`) `String(args.query)` searched for the literal term `undefined` and Jina returned MDN's `undefined` page — **`isError: false`, indistinguishable from a real result**. The required arguments of `jina_web_search` / `jina_search_arxiv` / `jina_search_ssrn` / `jina_expand` / `jina_rerank` / `jina_embed` / `jina_classify` / `jina_pdf` are now checked up front and **throw** (`isError: true`), naming the tool, the parameter and the suspected typo, without spending a request.
- **change** `jina_read` always asks for `Accept: application/json` and unwraps the envelope into markdown with `Title` / `URL Source` / `[Usage: …]`; an unparsable body is returned verbatim.
- **test** Added `test/reader-headers.test.js` (14 cases decoding the network helper's stdin) and `test/tool-args.test.js` (9 cases, opening with the exact `{queries:[…],num:6}` call from the field, including "a rejected call spends no request" and the untouched valid path), plus render/wiring assertions for the new controls. Full details in [change-log.en.md](./change-log.en.md).

## Features

Once installed, every session (all agent presets) gets 12 `jina_*` tools:

| Tool | Corresponding jina-cli command | Description |
| --- | --- | --- |
| `jina_web_search` | `jina search` | General web search (default web domain; images / blog domains; time filter and region/language hints supported) |
| `jina_search_arxiv` | `jina search --arxiv` | arXiv preprint search (CS / ML / math / physics, etc.; returns canonical arxiv.org paper links) |
| `jina_search_ssrn` | `jina search --ssrn` | SSRN paper search (economics / finance / law / management and other social sciences; returns papers.ssrn.com links) |
| `jina_read` | `jina read` | Read a web page as clean markdown; supports OCR (jina-ocr-v1), CSS target selectors and chrome filtering (see below) |
| `jina_screenshot` | `jina screenshot` | Web page screenshot, returns a hosted image URL (full-page capture supported) |
| `jina_datetime` | `jina datetime` | Guess a page's publish/update time |
| `jina_expand` | `jina expand` | Expand a search query into a set of related queries |
| `jina_embed` | `jina embed` | Embed texts (default jina-embeddings-v5-text-small) |
| `jina_rerank` | `jina rerank` | Rerank documents by relevance (default jina-reranker-v3.5) |
| `jina_classify` | `jina classify` | Text classification |
| `jina_pdf` | `jina pdf` | Extract figures/tables/equations from a PDF (arXiv ID supported) |
| `jina_primer` | `jina primer` | Current context: host clock (ISO time/unix/timezone/UTC offset), network facts (public IP + location, best-effort) and Jina account status (identity/balance) |

## Reader options (`jina_read`)

The card's "reader options" block — or the `jina-tools` section of `settings.yaml` directly — sets `jina_read`'s defaults. Every option can be **overridden per call** by the matching tool parameter.

| Option | Field | Default | Effect and cost |
| --- | --- | --- | --- |
| OCR document parsing | `useOcr` | off | Reads through `X-Respond-With: jina-ocr-v1`: the vendor's 3.4B document parser, which turns a scanned page, image-heavy PDF or formula/table-heavy document into Markdown in one pass (tables as HTML, formulas as LaTeX). **~40x the tokens**, and **an API key is required** — the Reader answers anonymous callers with 401, so the plugin skips the request entirely and says why. Use the `page` parameter for one page of a multi-page document |
| Image policy | `imagePolicy` | `all` | `all` = the API default; `alt` = alt text only (cheaper); `none` = drop images |
| Generate image alt text | `autoAltText` | off | `X-With-Generated-Alt`: captions images that lack one. **Needs an API key** (401 anonymously) and is **mutually exclusive with OCR** (it does not work when `X-Respond-With` is set). Because **supplying a key is what makes a read billable**, this is off by default |
| Selector group | `useSelectors` | on | Sends a conservative `X-Target-Selector` (article containers only) and `X-Remove-Selector` (header/footer/nav/cookie banners/ads/sidebars/comments). If nothing matches, the read is **retried against the full page** rather than returning empty |
| Target / remove selectors | `targetSelector` / `removeSelector` | empty = built-in lists | Override the built-in lists (for unusual site structures or a false positive) |

Every read also sends three zero-side-effect parameters: `X-Preset: agent` (the vendor's preset for AI agents — the docs state a preset only fills options the caller did not set explicitly, so it never overrides an explicit parameter), `X-Base: final` (resolve relative links against the post-redirect URL) and `X-Timeout: 120` (a slow-page safety net matched to the client's own 120 s ceiling).

Per-call parameters: `ocr`, `page`, `targetSelector`, `waitForSelector`, `removeSelector`, `noCache`, plus the existing `links` / `images` / `json` / `apiKey`.

> Why these defaults: the three fixed parameters are the Reader options that cost nothing in the worst case. OCR and alt-text generation need a key, cost 40x tokens or change billing, or conflict with another parameter — so they are off unless asked for. The two hidden, undocumented options (`X-Remove-Overlay`, `X-Detach-Invisibles`) are deliberately **not** enabled by default; the latter officially requires the browser engine and disables caching.

## Field tests (cross-checked against the built-in web_search)

So the model **doesn't have to memorize parameters** to pick the right search domain, academic search was split into two dedicated tools, `jina_search_arxiv` / `jina_search_ssrn` (backed by `jina search --arxiv` / `--ssrn`) — the tool name says it all, and the model calls them directly when the user asks for papers. The table below is a sampled comparison from 2026-08-13 on the same machine with a real network environment (VPN system proxy): the same query was run through this plugin and dsh's built-in `web_search`, then the results were manually verified.

| Scenario | This plugin (dsh-jina) | Built-in web_search | Verdict |
| --- | --- | --- | --- |
| Academic search (arXiv) | `jina_search_arxiv` "retrieval augmented generation survey" → **9/9 all canonical arxiv.org links**: 2312.10997 (classic RAG survey), 2506.00054, 2410.12837, 2501.09136 (Agentic RAG), 2405.07437, 2504.08748, etc. — every result on-topic with accurate abstracts | Same query returned arXiv **mirror sites** (ezproxy.obspm.fr, ar5iv, sinoxiv.napstic.cn) and BibTeX links; no canonical links | ✅ jina wins: canonical links + precise recall |
| Academic search (SSRN) | `jina_search_ssrn` "large language models financial markets" → **9/9 all papers.ssrn.com originals**: market sentiment prediction, LLM-simulated trading, AI herding, investor disagreement, etc. — highly relevant | No SSRN-specific search capability | ✅ jina wins: exclusive SSRN domain |
| Chinese news / community / official sources | `jina_web_search` puts official sources (government / company sites) first, plus `time` filtering | Relevant results, but official sources not ranked first | ✅ jina better: authoritative sources first + time filter |
| General academic search (no domain specified) | Default web domain covers Springer / IEEE / ACL moderately (use the dedicated tools above for academic search) | Broad coverage of Springer / IEEE / ACL | ✅ web_search better: use it for general academic search |

**Conclusion / division of labor**: academic papers → `jina_search_arxiv` / `jina_search_ssrn`; time-sensitive Chinese news → `jina_web_search` (+ `time`); general academic / engineering docs → built-in `web_search`. They complement each other and cover all search scenarios.

> Note: the table is a one-round sampled comparison (not a strict benchmark); results depend on that day's network and query choices. Both toolchains work in practice; treat the conclusions as selection guidance.

## Installation

Repository: https://github.com/minatoAI/jina-web-search-dsh-plugin

The plugin is distributed as a [bundle](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md) and installed into a profile with `dsh plugin` (use `pnpm dsh` instead of `dsh` when running from a source checkout):

> install from GitHub (no build script, so no allowBuilds grant needed)

```sh
dsh plugin --profile web add github:minatoAI/jina-web-search-dsh-plugin
```

> more robust: pin to a commit so later pushes don't change the installed code

```sh
dsh plugin --profile web add github:minatoAI/jina-web-search-dsh-plugin#<commit-sha>
```

> or install from a local folder (development)

```sh
dsh plugin --profile web add ./jina-dsh-plugin
```

**Restart** dsh after installing (new bundles take effect on next startup):

```sh
dsh --profile web
```

Then open the Web UI → Settings → **Plugins** → **Configuration** tab → expand the **Jina Tools** card → paste your API key → Save. Get a free key at https://jina.ai/.

The same card carries **Local proxy (optional)**: if your proxy client only listens on a loopback port (no system proxy, no `HTTP_PROXY` environment variable), type its address there — e.g. `http://127.0.0.1:7897` (the scheme is optional) → Save, and the next tool call uses it. When the proxy moves to another port, update this field; no dsh restart required.

The card's **API key / connection check** section shows the current key's identity (Jina account) and balance (credits), marks the key's source (saved on this page / key file / anonymous quota), and reports **the proxy address the check actually ran through**; click **Refresh** to re-check (saving or clearing the key or the proxy also triggers an automatic re-check). This data is served by the host-side plugin through the `/api/dsh-jina/primer` route (the same endpoint the `jina_primer` tool uses); **the plaintext key never leaves the host**, while the proxy address is plaintext configuration and is displayed on the page.

## API key resolution order

Each tool call looks up the key in the following order (first hit wins):

1. The `apiKey` tool-call parameter
2. The key saved on the settings page (credential reference `JINA_API_KEY`, persisted by dsh's credential store, e.g. `~/.dsh/.credentials.yaml`)
3. `jina-api-key.txt` in the session workspace
4. `jina-api-key.txt` in the dsh home directory (`$DSH_HOME`, default `~/.dsh`)

A key saved on the settings page takes effect immediately (no restart needed; resolved on every call). On HTTP 401 the plugin re-reads the file and retries once. Credential values are only ever sent up through `credentials.set`; no read endpoint returns the plaintext. You can also clear the key with one click on the page.

## Local proxy (a local proxy client)

Jina domains are blocked on direct connections and need a proxy. The plugin resolves a proxy on every call (changes take effect immediately):

| Priority | Source | Notes |
| --- | --- | --- |
| 1 | The card's "Local proxy" | the `proxyUrl` field of the `jina-tools` namespace — the recommended manual path |
| 2 | `JINA_PROXY_URL` environment variable | for profiles without a settings provider (e.g. headless) |
| 3 | Windows system proxy | discovered from the WinINET registry (when `ProxyEnable=1`); re-discovered once after a transport failure, so a VPN port change self-heals |
| 4 | Startup environment | the harness-resolved `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`, handed to the network helper by `subprocess` |

Rules and caveats:

- **Only `http://` and `https://` proxies are supported.** The network helper is `node -e` plus the global `fetch`, which honors proxy variables under `NODE_USE_ENV_PROXY`; any other scheme makes Node exit at startup, so such an address is refused with an explanation instead of being ignored or breaking the helper.
- **When the proxy client only listens on a port without being the system proxy** (WinINET `ProxyEnable=0x0`), priority 3 cannot see it — that is exactly the case the manual field exists for.
- A manually configured address **outranks** automatic discovery, and a transport failure never silently swaps it for a discovered one: the error names the address in use so a wrong port is obvious.
- The scheme may be omitted (`127.0.0.1:7897` equals `http://127.0.0.1:7897`), credentials are allowed (`http://user:pass@127.0.0.1:7897`), and any path/query is dropped.
- The address is stored in plaintext in dsh's settings document (the `jina-tools` section of `settings.yaml`) and is readable by the Web page — **use it only on a trusted local machine** and never commit an address carrying credentials.
- **Clear** returns to automatic detection (priority 3 → 4).

## Uninstall

```sh
dsh plugin --profile web remove dsh-jina
```

## Repository structure

```
jina-dsh-plugin/
├── package.json       # manifest: "dsh": { "bundle": {"patch": ...}, "client": {"platform": "web"} }; the browser half is exported via exports["./client"] → ui/client.js
├── cordis.patch.yml   # composition layer: one dual-face row dsh-jina (host tools + browser card; an exact-package-name row name is a hard requirement of the client-modules scan)
├── index.js           # host plugin: 12 tools (incl. dedicated jina_search_arxiv / jina_search_ssrn academic search) + network transport + JINA_API_KEY credential resolution + the jina-tools proxy and reader policy
├── proxy.js           # pure module: proxy address normalization / precedence / reader-policy defaults / settings schema (zero deps, unit-testable)
├── primer.js          # pure module: jina_primer parsing/formatting logic (zero deps, unit-testable)
├── test/
│   ├── primer.test.js        # jina_primer unit tests (auto-discovered by node --test)
│   ├── proxy.test.js         # proxy policy unit tests
│   ├── plugin-proxy.test.js  # mock-host proxy integration tests (incl. an opt-in live-proxy case)
│   ├── reader-headers.test.js# jina_read header contract tests (decodes the helper's stdin, asserts the headers really sent)
│   ├── client-bundle.test.js # browser-bundle contract tests (syntax + registration id + settings transport + option wiring)
│   ├── client-render.test.js # renders both views for real in a VM (catches scoping/binding defects)
│   └── tools.test.js         # jina_web_search model-facing contract tests (TDD)
├── ui/
│   ├── package.json   # subpackage manifest (exports["./client"]; the dsh.client declaration now lives in the root manifest)
│   ├── index.js       # empty host half (kept for the historical subpackage shape; the composition no longer references it)
│   └── client.js      # prebuilt browser bundle: the "Jina Tools" card (API key + local proxy + reader options)
├── change-log.md      # full changelog (Simplified Chinese)
├── change-log.en.md   # full changelog (English)
├── README.md          # Simplified Chinese README
└── README.en.md       # this file
```

## Development notes

- The host plugin only depends on Node built-ins and dsh host services (`fs`, `subprocess`, `tools`, `credentials`, `settings`, `webServer`) — no third-party npm dependencies; credentials go through dsh's native credential seam (referencing `JINA_API_KEY`) and the proxy setting through the plugin's own `jina-tools` namespace (`proxyUrl`, a zero-dependency duck-typed schemastery node built by `createSettingsSchema` in `proxy.js`), so it works with any profile composition out of the box.
- The client bundle is committed directly (`ui/client.js`), no build step — git installs work as-is. To change the UI, edit that file and restart. The registration id in the bundle's top-level `window.__ModuleLoader__.load` MUST equal the graph row id (the exact package name `dsh-jina`) — the module system matches registrations only by row id (a trailing `/client` excepted); registering under any other key (e.g. the old row name `dsh-jina/ui`) fails the whole page with `loaded without registering "dsh-jina"` + `Failed to load plugins`. The card registers into the `settings.plugin.item` slot declared by the Web settings package (Settings → Plugins → Configuration), the standard place for third-party plugin configuration.
- **The `remote.<ns>` injection rule**: the gateway's `$mount` registers every Remote namespace as its **own cordis service**, so a client plugin must declare `remote.<ns>` (e.g. `remote.credentials`, `remote.settings`) in its own `inject` before reading that property — declaring only `'remote'` is not enough, the property access itself throws `cannot get property "remote.settings" without inject`, and the error reaching the `settings.plugin.item` slot boundary makes the whole card disappear (the 0.6.0 regression, now pinned by `test/client-bundle.test.js`). This plugin declares `inject = ['slots','remote','remote.credentials','remote.settings']`, and the read sites keep a try/catch so a missing service degrades to a notice instead of crashing the slot.
- The key is managed through the credentials Remote namespace (`credentials.describe/set/unset`, with `credentials/reference-updated` forwarded by `remote`); the proxy field rides the `settings` Remote namespace (`remote.settings.describe/mutate`, each write fenced by the `revision` the page read, with external edits arriving as the forwarded `settings/document-updated`).
- The composition layer follows dsh conventions: one dual-face row `dsh-jina` carries both the host half and the browser half. The browser half is declared by the ROOT manifest's `dsh.client` (platform: web, graph edge `@deepseek-ai/dsh-api-remotes`) plus `exports["./client"]`; the host's client-modules service locates the root manifest by the row name (an exact package name) and wires it into the Web boot graph. Note the client-modules scan accepts only exact-package-name rows: subpath rows (e.g. `dsh-jina/ui`) are never scanned as client rows — the browser half must be declared at the package root.

## Tests

Pure logic (proxy policy, primer parsing/formatting, etc.) is covered by the Node
built-in test runner with zero dependencies:

```sh
npm test   # same as node --test (auto-discovers test/*.test.js)
```

- `test/proxy.test.js`, `test/primer.test.js`, `test/tools.test.js`: pure functions and the model-facing contract.
- `test/reader-headers.test.js`: drives the host half through a fake Cordis context and **decodes the network helper's stdin**, asserting the Reader headers `jina_read` really sends — the three fixed parameters (`X-Preset: agent` / `X-Base: final` / `X-Timeout: 120`), the image policy, the selector group and its "empty result" retry, the OCR switch with `X-Page`, zero requests when no key can be resolved, the three alt-text constraints (opt-in, key-gated, mutually exclusive with OCR), JSON-envelope unwrapping with usage, verbatim fallback for an unparsable body, and the settings schema's field retention and default resolution.
- `test/plugin-proxy.test.js`: drives the host half through a fake Cordis context and asserts the settings-namespace registration, proxy precedence, **the environment the network helper actually receives**, the error text, and the `/api/dsh-jina/primer` payload. Its `JINA_LIVE_PROXY=1` case really spawns the helper and completes one Jina request (clean environment + the manual address, proving the saved address — not a leftover environment variable — carried it):

  ```powershell
  $env:JINA_LIVE_PROXY='1'; $env:JINA_LIVE_PROXY_URL='http://127.0.0.1:7897'; npm test
  ```

  Where child processes cannot be spawned (a sandboxed runner) that case skips itself with the reason.
- `test/client-bundle.test.js`: parses the prebuilt `ui/client.js` and pins the registration id, the `jina-tools` key, the settings transport, and revision fencing — the bundle has no build step, so a syntax error would otherwise surface only at runtime.

Fixtures use real captured r.jina.ai / ipinfo.io response shapes; tests cover
parse tolerance, time-fact derivation, text/JSON rendering and the
"never prints undefined" contract.
