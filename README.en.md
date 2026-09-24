**English** | [简体中文](README.md)

# dsh-jina

A [Jina AI](https://jina.ai/) plugin (bundle) for DeepSeek Harness: it exposes Jina Reader / Search API capabilities to the model as tool calls, and adds a configuration form on the Web **Plugins** page (on the `dsh-jina` bundle card) for **several API keys (with automatic failover when one runs out of credits)** and the **endpoint domains (mainland mirrors / global / auto)**; on older harnesses the same card falls back to **Settings → Plugins → Configure**.

> **No proxy needed.** Jina's global domains (`r.jina.ai` / `s.jina.ai`) are DNS-poisoned in mainland China and their origin is unreachable, so the plugin defaults to the official mainland mirrors Jina provides, `r.jinaai.cn` / `s.jinaai.cn` (a mainland CDN, the same API and authentication), which are reachable directly. The plugin itself **configures no proxy at all**.

## Changelog

> Only the latest release is listed here; the full version history lives in [change-log.en.md](./change-log.en.md).

### 0.12.0 (2026-09-24)

- **feat** **New "endpoint" switch (mainland / global / auto) — the plugin needs no proxy from now on.** The `jina-tools` namespace gains an `endpoint` field, rendered on the card as a three-way select: `cn` = Jina's official mainland mirrors `r.jinaai.cn` / `s.jinaai.cn`; `global` = `r.jina.ai` / `s.jina.ai`; `auto` (default) = **use whichever side answered last, and switch to the other when it fails**, with the winner remembered in-process. Measured: the mainland mirror resolves to 182.140.172.x / 220.167.110.x (`Server: ESA`, Alibaba Cloud edge), answers 200 on a **direct connection through no proxy at all**, and returns content **byte-for-byte identical** to `r.jina.ai` through a proxy (7521 characters, the same title), settling at 1.1–1.2 s; `api.jina.ai` has no mainland domain (`api.jinaai.cn` → HTTP 525) and is blocked by SNI, so it went away with this change (see the next bullet).
- **change** **Five tools removed**: `jina_embed` / `jina_rerank` / `jina_classify` (`api.jina.ai`, which has no mainland domain), `jina_expand` (`s.jina.ai` does not support `query_expansion`), `jina_pdf` (`extract-pdf` exists only on `svip.jina.ai` and has no mainland mirror). The basis is real usage: across 21 days and 557 session logs those five tools accounted for just 21 call records (~10 calls) in total, against 2570 for `jina_read` and 1620 for `jina_web_search`. Those capabilities will be maintained in a separate repository.
- **change** **The entire proxy mechanism is gone**: `proxy.js` (proxy-address normalization / precedence / WinINET auto-discovery) is replaced by `settings.js` (settings and endpoint policy), and the card's "local proxy" input, the `JINA_PROXY_URL` environment variable, the proxy hint in error messages and the `proxy` field of `/api/dsh-jina/primer` are all removed. A mainland-domain request **appends** `jinaai.cn` to `NO_PROXY` (merging, never replacing, the inherited list), so a startup environment carrying `HTTP_PROXY` cannot push a domestic CDN address into the VPN.
- **change** **The search endpoint moved from `svip.jina.ai` to `s.jina.ai`** (mainland mirror `s.jinaai.cn`): this is the officially documented endpoint and both sides return the same shape `{ code, status, data: [{ title, url, description, date }] }`, so one formatter covers both routes (`fmtSearch` has been adapted, and still tolerates the old `{ results: [...] }` shape). The `domain` field has **no effect** on `s.jina.ai` (measured: it returned distill.pub results), so the arxiv / ssrn academic tools now use the `site` field, which does work (`site: 'arxiv.org'` / `site: 'ssrn.com'`).
- **fix** **A transport failure no longer retries the same host**: the old behaviour retried in place once, which with the 120 s timeout could take **240 s** to report an error. `auto` mode now treats the failure as a routing fact — move to the other side, try each host once, at most two attempts per call; a fixed mode (`cn` / `global`) errors on the first failure and names **the endpoint URLs actually tried**.
- **test** Full suite: **150 tests (149 pass, 1 opt-in skip, 0 fail)**. New `test/settings.test.js` (endpoint-policy pure functions: mode validation, routing order, `NO_PROXY` merging) and `test/plugin-endpoints.test.js` (fake-host integration: the global side by default, a transport failure switching to the mainland side and appending `NO_PROXY`, no fallback in a fixed mode, winner memory, the search domain pair for search, the `site` field, saves taking effect immediately, and the primer reporting the endpoint actually used), whose `JINA_LIVE_CN=1` case really spawns the helper for one mainland-domain request (verified, 824 ms).

## Features

Once installed, every session (all agent presets) gets 8 `jina_*` tools:

| Tool | Corresponding jina-cli command | Description |
| --- | --- | --- |
| `jina_web_search` | `jina search` | General web search (default web domain; images / blog domains; time filter and region/language hints supported) |
| `jina_search_arxiv` | `jina search --arxiv` | arXiv preprint search (CS / ML / math / physics, etc.; returns canonical arxiv.org paper links; scoped to the source with `site: arxiv.org`) |
| `jina_search_ssrn` | `jina search --ssrn` | SSRN paper search (economics / finance / law / management and other social sciences; returns papers.ssrn.com links; scoped to the source with `site: ssrn.com`) |
| `jina_read` | `jina read` | Read a web page as clean markdown, with target selectors and noise filtering (see below). **PDFs always use the plain extractor** — verbatim and ~40x cheaper than OCR |
| `jina_read_pdf` | `jina read` + `X-Respond-With: jina-ocr-v1` | **Read a PDF through `jina-ocr-v1`, one page per request** — the only path that works on scanned / image-only PDFs. `pages` picks pages (`"3"` / `"1-5"` / `"2,4,7"`), defaulting to the first 5 (`maxPages`, cap 50). **One page at a time** (the API silently serves page 1 for an out-of-range `X-Page`, which is how the tool detects the end of the document); results carry a provenance marker |
| `jina_screenshot` | `jina screenshot` | Web page screenshot, returns a hosted image URL (full-page capture supported) |
| `jina_datetime` | `jina datetime` | Guess a page's publish/update time |
| `jina_primer` | `jina primer` | Current context: host clock (ISO time/unix/timezone/UTC offset), network facts (public IP + location, best-effort) and Jina account status (identity/balance) |

## Reader options (`jina_read`)

The card's "reader options" block — or the `jina-tools` section of `settings.yaml` directly — sets `jina_read`'s defaults. Every option can be **overridden per call** by the matching tool parameter.

| Option | Field | Default | Effect and cost |
| --- | --- | --- | --- |
| Image policy | `imagePolicy` | `all` | `all` = the API default; `alt` = alt text only (cheaper); `none` = drop images |
| Generate image alt text | `autoAltText` | off | `X-With-Generated-Alt`: captions images that lack one. **Needs an API key** (401 anonymously) and is **mutually exclusive with OCR** (it does not work when `X-Respond-With` is set). Because **supplying a key is what makes a read billable**, this is off by default |
| Selector group | `useSelectors` | on | Sends a conservative `X-Target-Selector` (article containers only) and `X-Remove-Selector` (header/footer/nav/cookie banners/ads/sidebars/comments). If nothing matches, the read is **retried against the full page** rather than returning empty |
| Target / remove selectors | `targetSelector` / `removeSelector` | empty = built-in lists | Override the built-in lists (for unusual site structures or a false positive) |

Every read also sends three zero-side-effect parameters: `X-Preset: agent` (the vendor's preset for AI agents — the docs state a preset only fills options the caller did not set explicitly, so it never overrides an explicit parameter), `X-Base: final` (resolve relative links against the post-redirect URL) and `X-Timeout: 120` (a slow-page safety net matched to the client's own 120 s ceiling).

Per-call parameters (`jina_read`): `targetSelector`, `waitForSelector`, `removeSelector`, `noCache`, plus the existing `links` / `images` / `json` / `apiKey`.
Per-call parameters (`jina_read_pdf`): `url`, `pages`, `maxPages`, `allowNonPdf`, `apiKey`. A URL that is not a `.pdf` is refused (`allowNonPdf: true` forces it through) — because `jina-ocr-v1` **fabricates content** on ordinary web pages.

> Why these defaults: the three fixed parameters are the Reader options that cost nothing in the worst case. Alt-text generation needs a key and changes billing, so it is off unless asked for. The two hidden, undocumented options (`X-Remove-Overlay`, `X-Detach-Invisibles`) are deliberately **not** enabled by default; the latter officially requires the browser engine and disables caching.

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

Then open the Web UI → Settings → **Plugins** → **Configuration** tab → expand the **Jina Tools** card → paste your key into the **API key** section → click 添加. You can **keep adding**: every click stores one more key, and the card never shows or asks you to manage an individual key. Get a free key at https://jina.ai/. **Add at least two**: when any key is revoked or runs out of credits the plugin discards it and switches to the next one, so the task is not interrupted (see below).

## Updating

The plugin is a profile dependency, so an upgrade is **make the profile fetch the new code again, then restart dsh**. For the `web` profile:

1. Pull the new version into the profile (any one of these):

   ```sh
   # A. Re-resolve the GitHub dependency (recommended)
   cd "$DSH_HOME/profiles/web"        # Windows: C:\Users\<you>\.dsh\profiles\web
   pnpm update dsh-jina

   # B. Remove and re-add (equivalent — both fetch the branch head)
   dsh plugin --profile web remove dsh-jina
   dsh plugin --profile web add github:minatoAI/jina-web-search-dsh-plugin

   # C. Web UI: sidebar → Plugins → remove dsh-jina → install the GitHub URL above
   ```

2. **Restart** dsh so the new code is loaded:

   ```sh
   dsh --profile web
   ```

3. Check that it worked:

   ```sh
   # The installed copy's version (this repo bumps package.json on every release)
   Get-Content "$DSH_HOME/profiles/web/node_modules/dsh-jina/package.json" | Select-String '"version"'
   ```

   Then open the card and click **Refresh** once to confirm it works (the "Key 总数 / 总余额" lines).

> **Why a plain `pnpm install` usually does not upgrade**: a GitHub dependency is pinned in `pnpm-lock.yaml` to the commit resolved at install time, and `pnpm install` honours the lockfile; only `pnpm update dsh-jina` (or remove + add) re-resolves the branch head. Pinning at install time (`...#<commit-sha>`) behaves the same way — upgrading means explicitly switching to the new SHA.
>
> A local-folder install (`add ./jina-dsh-plugin`) never touches the remote: `git pull` in that directory and restart dsh.

The same card also carries the **endpoint domains**: a three-way select deciding which pair of domains each call uses — **mainland** (`r.jinaai.cn` / `s.jinaai.cn`, Jina's official mainland mirrors, a domestic CDN reached directly with no proxy/VPN), **global** (`r.jina.ai` / `s.jina.ai`) and **auto** (the default: use whichever side answered last, and switch to the other when it fails). Selecting saves immediately, and the next tool call uses it — no dsh restart.

The card's **API key / connection check** section reports only two things: **how many keys it holds** and **the total balance** (the credits behind the surviving keys), plus the connection state and **the endpoint domains the check actually used**; click **Refresh** to re-check (adding a key or changing the endpoint also triggers an automatic re-check). **Nothing per key is shown** — no plaintext, no fingerprint, no "which one is in use", and no manual removal. This data is served by the host-side plugin through the `/api/dsh-jina/primer` route (the same endpoint the `jina_primer` tool uses); **the plaintext key never leaves the host**.

## API key resolution, rotation and automatic discard

Each tool call resolves keys in the following order; **the first source that yields a key is that call's rotation pool** (every key inside a source joins the rotation, and later sources are not consulted):

1. The `apiKey` tool-call parameter (**a single key, never rotated** — the "use exactly this one" escape hatch)
2. The keys added on the card, in the order they were added (persisted by dsh's credential store, e.g. `~/.dsh/.credentials.yaml`; the same names work as environment variables, so headless profiles are covered too)
3. `jina-api-key.txt` in the session workspace (**one key per line**; blank lines and `#` comments ignored)
4. `jina-api-key.txt` in the dsh home directory (`$DSH_HOME`, default `~/.dsh`) (likewise one key per line)

### Rotation and discard rules

| Upstream status | Meaning | Behaviour |
| --- | --- | --- |
| `401` | key revoked / expired | switch to the next key, and **discard that key from the credential store** |
| `402` | quota exhausted | switch to the next key, and **discard that key** |
| balance ≤ 0 | the health check finds the credits gone | **discard that key** |
| `429` | rate limited | switch to the next key but **never discard** (temporary); it returns to the rotation after a one-minute cooldown |
| `0` / `422` / `5xx` | network, arguments, upstream fault | **neither rotate nor discard** (another key cannot fix it and would only waste the rest of the pool) |

- **Self-managing**: a usable key stays, an unusable one is discarded automatically — which is why the card has no remove control and shows nothing per key. The user only ever adds.
- **Round-robin**: every call starts at the key **after** the one used last, so N keys each carry roughly 1/N of the traffic — Jina's rate limits (RPM/TPM) are counted per key, and spreading the load is what keeps a busy session out of 429. **A planned rotation never** prints the "switched" line (only a switch caused by a real failure does).
- **The switch is visible**: a mid-call switch appends one line such as `[已自动切换 API key: #1 (credential JINA_API_KEY) quota exhausted (HTTP 402), 已自动移除; switched to #2 (credential JINA_API_KEY_2). 可在 Plugins → dsh-jina 卡片里添加新的 key。]`; a `json: true` payload is never touched.
- **A fully exhausted pool** reports every key it tried, its source and its status (e.g. `#1 (credential JINA_API_KEY) quota exhausted (HTTP 402), 已自动移除; #2 (workspace jina-api-key.txt line 2) rate limited (HTTP 429)`) and points at adding a key or topping up.
- Adding a key takes effect immediately (no restart; resolved on every call, and credential values are only ever sent up through `credentials.set` — no read endpoint returns the plaintext).
- The same key appearing in several slots or in the file is requested only once.
- **Key files and read-only sources are never deleted**: a key from `jina-api-key.txt` (the plugin will not rewrite a user's file) and a reference supplied read-only by the launching environment (the seam refuses the write) are only skipped, never removed from disk.

## Endpoint domains (no proxy needed)

Jina's global domains `r.jina.ai` / `s.jina.ai` are **DNS-poisoned** in mainland China and their origin addresses are blackholed, so a direct connection always fails. Jina therefore provides mainland mirror domains (see [jina-ai/reader#1237](https://github.com/jina-ai/reader/issues/1237)): `r.jina.ai → r.jinaai.cn` and `s.jina.ai → s.jinaai.cn` — **the API, parameters and authentication are identical, only the domain changes**.

| Mode | Domains used | When |
| --- | --- | --- |
| `cn` (mainland) | `r.jinaai.cn` / `s.jinaai.cn` | Mainland China networks. A domestic CDN reached directly, **needs no proxy at all**; pinning this side means it never falls back to the global domains |
| `global` | `r.jina.ai` / `s.jina.ai` | Overseas networks, or when you bring your own proxy |
| `auto` (default) | both | Use whichever side answered last, and switch to the other when it fails. **Each host is tried once**, at most two attempts per call; the winner is remembered in-process, so only the first call may pay for one extra probe |

Rules and caveats:

- **The plugin no longer configures any proxy**: there is no proxy input on the card and it does not read `JINA_PROXY_URL`. You can still run your own VPN/system proxy, but the plugin never discovers or sets one.
- **Mainland-domain requests bypass an inherited proxy**: if the environment that started dsh carries `HTTP_PROXY` / `HTTPS_PROXY`, a mainland-domain attempt **appends** `jinaai.cn` to `NO_PROXY` (keeping the existing list), so a domestic CDN address is not pushed into the VPN.
- **Measured data**: `r.jinaai.cn` answers 200 on a direct, proxy-less connection and returns content byte-for-byte identical to `r.jina.ai` through a proxy (7521 characters, the same title), settling at 1.1–1.2 s (24.8 s on the first cold start while the CDN warms its origin); the `s.jinaai.cn` search endpoint returns 200 with a key. `api.jina.ai` has no mainland domain (`api.jinaai.cn` → HTTP 525), and its SNI is blocked (the same Cloudflare IP answers normally with SNI `cloudflare.com` but gets an immediate `ECONNRESET` with SNI `api.jina.ai`) — which is also why `jina_embed` / `jina_rerank` / `jina_classify` were removed.
- **Error messages name the domains actually tried**, e.g. "endpoints tried: https://r.jina.ai/, https://r.jinaai.cn/", so it is easy to tell whether the global side is blocked or the whole local network is down.
- When a domain's resolved IP changes, no configuration change is needed (system DNS resolution is used); if the vendor ever retires the `.cn` domains, switch the mode to "auto" or "global" and bring your own proxy.
- **Upgrading**: 0.11.x and earlier may have stored a `proxyUrl` in the `jina-tools` section. The new version never reads that field, so leaving it is harmless; delete the line if you want the document clean.

## Uninstall

```sh
dsh plugin --profile web remove dsh-jina
```

## Repository structure

```
jina-dsh-plugin/
├── package.json       # manifest: "dsh": { "bundle": {"patch": ...}, "client": {"platform": "web"} }; the browser half is exported via exports["./client"] → ui/client.js
├── cordis.patch.yml   # composition layer: one dual-face row dsh-jina (host tools + browser card; an exact-package-name row name is a hard requirement of the client-modules scan)
├── index.js           # host plugin: 8 tools (incl. dedicated jina_search_arxiv / jina_search_ssrn academic search and the jina_read_pdf OCR tool) + network transport (dual-endpoint routing) + the multi-key round-robin pool (JINA_API_KEY / _2 … _10 + key files)
├── keys.js            # pure module: key-pool policy (credential refs / key-file parsing / rotation order and cooldowns / status labels; zero deps, unit-testable)
├── settings.js        # pure module: endpoint policy (mainland / global / auto routing order and the NO_PROXY override) + reader-policy defaults and the settings schema (zero deps, unit-testable)
├── primer.js          # pure module: jina_primer parsing/formatting logic (zero deps, unit-testable)
├── test/
│   ├── primer.test.js        # jina_primer unit tests (auto-discovered by node --test)
│   ├── settings.test.js      # endpoint-policy unit tests (mode validation / routing order / NO_PROXY merging)
│   ├── keys.test.js          # key-pool policy unit tests (rotation / cooldowns / parsing / discard decision)
│   ├── multi-key.test.js     # mock-host multi-key integration tests (asserts Authorization per request and the failover)
│   ├── plugin-endpoints.test.js # mock-host endpoint-routing integration tests (incl. an opt-in live mainland-domain case)
│   ├── reader-headers.test.js# jina_read header contract tests (decodes the helper's stdin, asserts the headers really sent)
│   ├── client-bundle.test.js # browser-bundle contract tests (syntax + registration id + settings transport + single-input key form wiring)
│   ├── client-render.test.js # renders both views for real in a VM (catches scoping/binding defects)
│   └── tools.test.js         # jina_web_search model-facing contract tests (TDD)
├── ui/
│   ├── package.json   # subpackage manifest (exports["./client"]; the dsh.client declaration lives in the root manifest, this only keeps the subpackage complete)
│   ├── index.js       # empty host half (kept for the historical subpackage shape; the composition no longer references it)
│   └── client.js      # prebuilt browser bundle: the "Jina Tools" card on the Plugins page (single key input + endpoint domains + reader options)
├── change-log.md      # full changelog (Simplified Chinese)
├── change-log.en.md   # full changelog (English)
├── README.md          # Simplified Chinese README
└── README.en.md       # this file
```

## Development notes

- The host plugin only depends on Node built-ins and dsh host services (`fs`, `subprocess`, `tools`, `credentials`, `llm`, `webServer`) — no third-party npm dependencies; credentials go through dsh's native credential seam (the key pool references `JINA_API_KEY` / `JINA_API_KEY_2` … `JINA_API_KEY_10`; the seam stores one value per reference and no read endpoint returns a value, so "several keys" means "several references", and any POSIX identifier is a legal reference name — no harness change is needed) and the configuration through the plugin's own `jina-tools` settings namespace (the `endpoint` domain field plus the `imagePolicy` / `autoAltText` / `useSelectors` / three selector overrides reader policies), so it works with any profile composition out of the box.
- **The settings-seam contract (dsh 0.1.4 onward)**: `settings.register()` is gone — **a settings namespace *is* the Loader/profile composition entry id**, and the row this plugin inserts in `cordis.patch.yml` is exactly `jina-tools` (which is why the card's `NS` matches). The plugin declares its editable fields through `export const Config = createSettingsSchema()` in `index.js` (`settings.js`, a zero-dependency hand-written node): every field node carries `meta.volatile: true`, and `'~standard': { version: 1, vendor: 'schemastery', validate }` is the harness's only entry point for resolving config (`resolveConfig()` requires a **synchronous plain object**; `vendor` must be `'schemastery'` or every save degrades into a full plugin remount). `validate()` builds one **cross-copy-safe volatile reference** per field (`Symbol.for('cosmokit.volatile.write')`); on save the harness only writes the new value into those references, so the object `apply(ctx, config)` captured keeps its identity, the plugin is never remounted, and it re-reads `settingsSnapshot(config)` on **every operation** (`toolSettingsOf()` normalizes "unset" into the documented defaults). Saving therefore takes effect immediately, with no restart — the same contract as the API key. The primer payload's `settingsLive` field is the health check for exactly this.
- The client bundle is committed directly (`ui/client.js`), no build step — git installs work as-is. To change the UI, edit that file and restart. The registration id in the bundle's top-level `window.__ModuleLoader__.load` MUST equal the graph row id (the exact package name `dsh-jina`) — the module system matches registrations only by row id (a trailing `/client` excepted); registering under any other key (e.g. the old row name `dsh-jina/ui`) fails the whole page with `loaded without registering "dsh-jina"` + `Failed to load plugins`. The card registers into the `settings.plugin.item` slot declared by the Web settings package (Settings → Plugins → Configuration), the standard place for third-party plugin configuration.
- **The `remote.<ns>` injection rule**: the gateway's `$mount` registers every Remote namespace as its **own cordis service**, so a client plugin must declare `remote.<ns>` (e.g. `remote.credentials`, `remote.settings`) in its own `inject` before reading that property — declaring only `'remote'` is not enough, the property access itself throws `cannot get property "remote.settings" without inject`, and the error reaching the `settings.plugin.item` slot boundary makes the whole card disappear (the 0.6.0 regression, now pinned by `test/client-bundle.test.js`). This plugin declares `inject = ['slots','remote','remote.credentials','remote.settings']`, and the read sites keep a try/catch so a missing service degrades to a notice instead of crashing the slot.
- The keys are managed through the credentials Remote namespace (`credentials.describe/set/unset`, with `credentials/reference-updated` forwarded by `remote`): the card describes all ten slots in one batch to learn "configured / source / writable" for each (**a value is never returned** — it crosses the wire only on save), and the form is therefore **one input** — 添加 writes into the first free slot, while the host half uses `credentials.unset` to **discard** a slot that answers 401/402 or reports no credits left (the card itself never calls `unset`, and shows nothing per key). The `KEY_REFS` table in `ui/client.js` must match `keys.js` exactly (the credentials namespace has no enumeration, so the card can only describe reference names it writes down), pinned by `test/client-bundle.test.js`. The rotation/cooldown policy lives in `keys.js` (pure functions) and the host half re-resolves the whole pool on every operation (the same "resolve per call" contract the single key always had); `/api/dsh-jina/primer` probes every key in parallel, cleans up dead keys, and returns just four numbers — usable count, key count, total balance, discarded count. The endpoint field rides the `settings` Remote namespace (`remote.settings.describe/mutate`, each write fenced by the `revision` the page read, with external edits arriving as the forwarded `settings/document-updated`).
- The composition layer follows dsh conventions: one dual-face row `dsh-jina` carries both the host half and the browser half. The browser half is declared by the ROOT manifest's `dsh.client` (platform: web, graph edge `@deepseek-ai/dsh-api-remotes`) plus `exports["./client"]`; the host's client-modules service locates the root manifest by the row name (an exact package name) and wires it into the Web boot graph. Note the client-modules scan accepts only exact-package-name rows: subpath rows (e.g. `dsh-jina/ui`) are never scanned as client rows — the browser half must be declared at the package root.

## Tests

Pure logic (endpoint policy, primer parsing/formatting, etc.) is covered by the Node
built-in test runner with zero dependencies:

```sh
npm test   # same as node --test (auto-discovers test/*.test.js)
```

- `test/settings.test.js`, `test/primer.test.js`, `test/keys.test.js`, `test/tools.test.js`: pure functions and the model-facing contract (`keys.test.js` covers the reference grammar, key-file parsing, status mapping, cooldown folding, rotation order, the pool signature and source labels; `settings.test.js` covers endpoint-mode validation, routing order and `NO_PROXY` merging).
- `test/multi-key.test.js`: drives the host half through a fake Cordis context, decodes the network helper's stdin for every request and asserts the `Authorization` header — covering a 402 handing over to a backup key **and deleting it from the credential store**, 401 doing the same, 429 only parking, read-only and file-sourced keys never deleted, round-robin rotation and cooldown skipping, a three-key walk, no rotation on 422/5xx/network failure (**a transport failure only switches the endpoint domain, never the key**), an explicit `apiKey` never rotating, per-key reporting for an exhausted pool, the key-file fallback with several lines, duplicate-key collapsing, an added key reaching the next call, and a primer route that returns only counts and the total while discarding a zero-balance key.
- `test/reader-headers.test.js`: drives the host half through a fake Cordis context and **decodes the network helper's stdin**, asserting the Reader headers `jina_read` really sends — the three fixed parameters (`X-Preset: agent` / `X-Base: final` / `X-Timeout: 120`), the image policy, the selector group and its "empty result" retry, the OCR switch and `X-Page`, zero requests when no key can be resolved, the three alt-text constraints (opt-in, key-gated, mutually exclusive with OCR), JSON-envelope unwrapping with usage, verbatim fallback for an unparsable body, the schema's field declarations (all seven fields carry `meta.volatile`), the validator's tolerant surface, and "a save reaches the next call".
- `test/plugin-endpoints.test.js`: drives the host half through a fake Cordis context and asserts the `Config` export's volatile contract, **the URL each attempt really requests**, **the environment the network helper actually receives** (a mainland domain gets `NO_PROXY` appended, every other case inherits it whole), the domains named in the error text, and the `/api/dsh-jina/primer` payload (including `settingsLive` and the endpoint side this check used). Its `JINA_LIVE_CN=1` case really spawns the helper and completes one mainland-domain request:

  ```powershell
  $env:JINA_LIVE_CN='1'; npm test
  ```

  Where child processes cannot be spawned (a sandboxed runner) that case skips itself with the reason.
- `test/client-bundle.test.js`: parses the prebuilt `ui/client.js` and pins the registration id, the `jina-tools` key, the settings transport, revision fencing, the **single-input key form** (one `keyDraft` string + `firstFreeRef` + add, and the card itself never calls `unset`) and its agreement with `keys.js` — the bundle has no build step, so a syntax error would otherwise surface only at runtime.

Fixtures use real captured r.jina.ai / ipinfo.io response shapes; tests cover
parse tolerance, time-fact derivation, text/JSON rendering and the
"never prints undefined" contract.
