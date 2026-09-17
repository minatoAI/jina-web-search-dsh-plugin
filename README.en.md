**English** | [简体中文](README.md)

# dsh-jina

A [Jina AI](https://jina.ai/) plugin (bundle) for DeepSeek Harness: it exposes the full jina-cli API surface to the model as tool calls, and adds a configuration form on the Web **Plugins** page (on the `dsh-jina` bundle card) for your API key and a **local proxy address**; on older harnesses the same card falls back to **Settings → Plugins → Configure**.

## Changelog

> Only the latest release is listed here; the full version history lives in [change-log.en.md](./change-log.en.md).

### 0.7.0 (2026-09-17)

- **compat** Adapted to the current dsh: the configuration slot moved from `settings.plugin.item` (keyed; Settings → Plugins → Configure) to `plugins.bundle.config` (keyed by the bundle's package name, rendered on the dsh-jina bundle card on the Plugins page; the host asks for `summary` and `page` views). The old slot is removed upstream, so without this change the card **silently disappears** and neither the key nor the proxy can be configured.
- **compat** The legacy `settings.plugin.item` registration is kept, so both harness generations can configure the bundle; drop the arm marked Legacy in `ui/client.js` when old harnesses no longer matter.
- **test** The browser-bundle contract tests gained assertions for the new slot and its two views; the legacy-slot assertions remain.

### 0.6.1 (2026-09-16)

- **fix** Fixed the browser-half crash 0.6.0 introduced, which made the whole **Jina Tools card disappear** (live console: `Error: cannot get property "remote.settings" without inject` → `slot entry crashed in 'settings.plugin.item'`). The gateway mounts every Remote namespace as its own cordis service `remote.<ns>`, and a consumer must declare that service name in its own `inject` before reading the property; `'remote.settings'` is now declared and the read is wrapped in try/catch, so a missing service degrades to a notice instead of crashing the slot.
- **test** The browser-bundle contract tests now verify that `exports.inject` lists exactly the `remote.<ns>` services the card reads.

> 0.6.0 (2026-09-15): **manual local-proxy configuration** (card field, proxy precedence, connection diagnostics) — see the "Local proxy" section below; full history in [change-log.en.md](./change-log.en.md).

## Features

Once installed, every session (all agent presets) gets 12 `jina_*` tools:

| Tool | Corresponding jina-cli command | Description |
| --- | --- | --- |
| `jina_web_search` | `jina search` | General web search (default web domain; images / blog domains; time filter and region/language hints supported) |
| `jina_search_arxiv` | `jina search --arxiv` | arXiv preprint search (CS / ML / math / physics, etc.; returns canonical arxiv.org paper links) |
| `jina_search_ssrn` | `jina search --ssrn` | SSRN paper search (economics / finance / law / management and other social sciences; returns papers.ssrn.com links) |
| `jina_read` | `jina read` | Read a web page as clean markdown |
| `jina_screenshot` | `jina screenshot` | Web page screenshot, returns a hosted image URL (full-page capture supported) |
| `jina_datetime` | `jina datetime` | Guess a page's publish/update time |
| `jina_expand` | `jina expand` | Expand a search query into a set of related queries |
| `jina_embed` | `jina embed` | Embed texts (default jina-embeddings-v5-text-small) |
| `jina_rerank` | `jina rerank` | Rerank documents by relevance (default jina-reranker-v3.5) |
| `jina_classify` | `jina classify` | Text classification |
| `jina_pdf` | `jina pdf` | Extract figures/tables/equations from a PDF (arXiv ID supported) |
| `jina_primer` | `jina primer` | Current context: host clock (ISO time/unix/timezone/UTC offset), network facts (public IP + location, best-effort) and Jina account status (identity/balance) |

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
├── index.js           # host plugin: 12 tools (incl. dedicated jina_search_arxiv / jina_search_ssrn academic search) + network transport + JINA_API_KEY credential resolution + the jina-tools proxy setting
├── proxy.js           # pure module: proxy address normalization / precedence / settings schema (zero deps, unit-testable)
├── primer.js          # pure module: jina_primer parsing/formatting logic (zero deps, unit-testable)
├── test/
│   ├── primer.test.js        # jina_primer unit tests (auto-discovered by node --test)
│   ├── proxy.test.js         # proxy policy unit tests
│   ├── plugin-proxy.test.js  # mock-host proxy integration tests (incl. an opt-in live-proxy case)
│   ├── client-bundle.test.js # browser-bundle contract tests (syntax + registration id + settings transport)
│   └── tools.test.js         # jina_web_search model-facing contract tests (TDD)
├── ui/
│   ├── package.json   # subpackage manifest (exports["./client"]; the dsh.client declaration now lives in the root manifest)
│   ├── index.js       # empty host half (kept for the historical subpackage shape; the composition no longer references it)
│   └── client.js      # prebuilt browser bundle: the "Jina Tools" card (API key + local proxy) under Settings → Plugins → Configuration
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
- `test/plugin-proxy.test.js`: drives the host half through a fake Cordis context and asserts the settings-namespace registration, proxy precedence, **the environment the network helper actually receives**, the error text, and the `/api/dsh-jina/primer` payload. Its `JINA_LIVE_PROXY=1` case really spawns the helper and completes one Jina request (clean environment + the manual address, proving the saved address — not a leftover environment variable — carried it):

  ```powershell
  $env:JINA_LIVE_PROXY='1'; $env:JINA_LIVE_PROXY_URL='http://127.0.0.1:7897'; npm test
  ```

  Where child processes cannot be spawned (a sandboxed runner) that case skips itself with the reason.
- `test/client-bundle.test.js`: parses the prebuilt `ui/client.js` and pins the registration id, the `jina-tools` key, the settings transport, and revision fencing — the bundle has no build step, so a syntax error would otherwise surface only at runtime.

Fixtures use real captured r.jina.ai / ipinfo.io response shapes; tests cover
parse tolerance, time-fact derivation, text/JSON rendering and the
"never prints undefined" contract.
