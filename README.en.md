**English** | [简体中文](README.md)

# dsh-jina

A [Jina AI](https://jina.ai/) plugin (bundle) for DeepSeek Harness: it exposes the full jina-cli API surface to the model as tool calls, and adds a **Jina Tools** card under **Plugins → Configuration** in the Web settings (the same standard plugin configuration location as Terminal / Agent Loop / Web Search) to configure your API key.

## Changelog

> Only the latest release is listed here; the full version history lives in [change-log.en.md](./change-log.en.md).

### 0.5.2 (2026-08-29)

- **fix** Fix the `Failed to load plugins` page after installing the plugin (`failed to import loader entry … (dsh-jina): client-modules: bundle … loaded without registering "dsh-jina"`): 0.5.1 renamed the composition row to the exact package name `dsh-jina`, but the browser bundle still registered under the old row name `dsh-jina/ui` — the module system only matches a registration against the graph row id (exact package name; `stripClientSuffix` trims only a trailing `/client`), so `dsh-jina/ui` landed on a key nobody asks for, `arrive()` saw no `dsh-jina` factory, and the script "loaded without registering". Fix: registration id is now the graph row id `dsh-jina`.
- **fix** Use the standard injection for the credential namespace: per the api-gateway client sources, `remote.credentials` is its own cordis **service** registered by `$mount` (`Service(ctx, 'remote.credentials')`, via `remoteServiceKey('credentials')`) — not a property on the `remote` object; the old code read `.credentials` from `ctx.get('remote')` and got `undefined`. The plugin `inject` now includes `'remote.credentials'` and the card receives that service directly (`describe/set/unset` and the `credentials/reference-updated` event, still forwarded by `remote`, are unchanged).
- **docs** Update "Development notes".

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

```sh
# install from GitHub (no build script, so no allowBuilds grant needed)
dsh plugin --profile web add github:minatoAI/jina-web-search-dsh-plugin

# more robust: pin to a commit so later pushes don't change the installed code
dsh plugin --profile web add github:minatoAI/jina-web-search-dsh-plugin#<commit-sha>

# or install from a local folder (development)
dsh plugin --profile web add ./jina-dsh-plugin
```

**Restart** dsh after installing (new bundles take effect on next startup):

```sh
dsh --profile web
```

Then open the Web UI → Settings → **Plugins** → **Configuration** tab → expand the **Jina Tools** card → paste your API key → Save. Get a free key at https://jina.ai/.

The card's **API key detection** section shows the current key's identity (Jina account) and balance (credits) in real time, and marks the key's source (saved on this page / key file / anonymous quota) so you can confirm the key is actually in effect; click **Refresh** to re-check (saving/clearing the key also triggers an automatic re-check). This data is served by the host-side plugin through the `/api/dsh-jina/primer` route (the same endpoint the `jina_primer` tool uses); **the plaintext key never leaves the host**.

## API key resolution order

Each tool call looks up the key in the following order (first hit wins):

1. The `apiKey` tool-call parameter
2. The key saved on the settings page (credential reference `JINA_API_KEY`, persisted by dsh's credential store, e.g. `~/.dsh/.credentials.yaml`)
3. `jina-api-key.txt` in the session workspace
4. `jina-api-key.txt` in the dsh home directory (`$DSH_HOME`, default `~/.dsh`)

A key saved on the settings page takes effect immediately (no restart needed; resolved on every call). On HTTP 401 the plugin re-reads the file and retries once. Credential values are only ever sent up through `credentials.set`; no read endpoint returns the plaintext. You can also clear the key with one click on the page.

## Network & proxy (mainland China users)

Jina domains are blocked on direct connections and require a VPN. The plugin reaches Jina through the system proxy: before every call it discovers the system proxy address from the WinINET registry, and on transfer failure it re-discovers and retries once — it self-heals when a VPN restart changes the port. When the VPN is off, the tools return an error message with hints.

## Uninstall

```sh
dsh plugin --profile web remove dsh-jina
```

## Repository structure

```
jina-dsh-plugin/
├── package.json       # manifest: "dsh": { "bundle": {"patch": ...}, "client": {"platform": "web"} }; the browser half is exported via exports["./client"] → ui/client.js
├── cordis.patch.yml   # composition layer: one dual-face row dsh-jina (host tools + browser card; an exact-package-name row name is a hard requirement of the client-modules scan)
├── index.js           # host plugin: 12 tools (incl. dedicated jina_search_arxiv / jina_search_ssrn academic search) + network transport + JINA_API_KEY credential resolution
├── primer.js          # pure module: jina_primer parsing/formatting logic (zero deps, unit-testable)
├── test/
│   ├── primer.test.js # jina_primer unit tests (auto-discovered by node --test)
│   └── tools.test.js  # jina_web_search model-facing contract tests (TDD)
├── ui/
│   ├── package.json   # subpackage manifest (exports["./client"]; the dsh.client declaration now lives in the root manifest)
│   ├── index.js       # empty host half (kept for the historical subpackage shape; the composition no longer references it)
│   └── client.js      # prebuilt browser bundle: the "Jina Tools" card under Settings → Plugins → Configuration
├── change-log.md      # full changelog (Simplified Chinese)
├── change-log.en.md   # full changelog (English)
├── README.md          # Simplified Chinese README
└── README.en.md       # this file
```

## Development notes

- The host plugin only depends on Node built-ins and dsh host services (`fs`, `subprocess`, `tools`, `credentials`) — no third-party npm dependencies; credentials go through dsh's native credential seam (referencing `JINA_API_KEY`), so it works with any profile composition out of the box.
- The client bundle is committed directly (`ui/client.js`), no build step — git installs work as-is. To change the UI, edit that file and restart. The registration id in the bundle's top-level `window.__ModuleLoader__.load` MUST equal the graph row id (the exact package name `dsh-jina`) — the module system matches registrations only by row id (a trailing `/client` excepted); registering under any other key (e.g. the old row name `dsh-jina/ui`) fails the whole page with `loaded without registering "dsh-jina"` + `Failed to load plugins`. The card registers into the `settings.plugin.item` slot declared by the Web settings package (Settings → Plugins → Configuration), the standard place for third-party plugin configuration; the key is managed via the standard credential Remote namespace: `remote.credentials` is its own **service** registered by the gateway's `$mount` (declare `'remote.credentials'` in the plugin `inject`; do not read it off the `remote` object) — `credentials.describe/set/unset`, with the change event `credentials/reference-updated` forwarded by `remote`; this is the only configuration channel open to third-party plugins (the settings namespace is allowlist-restricted for browsers).
- The composition layer follows dsh conventions: one dual-face row `dsh-jina` carries both the host half and the browser half. The browser half is declared by the ROOT manifest's `dsh.client` (platform: web, graph edge `@deepseek-ai/dsh-api-remotes`) plus `exports["./client"]`; the host's client-modules service locates the root manifest by the row name (an exact package name) and wires it into the Web boot graph. Note the client-modules scan accepts only exact-package-name rows: subpath rows (e.g. `dsh-jina/ui`) are never scanned as client rows — the browser half must be declared at the package root.

## Tests

Pure logic (primer parsing/formatting, etc.) is covered by the Node built-in test
runner with zero dependencies:

```sh
npm test   # same as node --test (auto-discovers test/*.test.js)
```

Fixtures use real captured r.jina.ai / ipinfo.io response shapes; tests cover
parse tolerance, time-fact derivation, text/JSON rendering and the
"never prints undefined" contract.
