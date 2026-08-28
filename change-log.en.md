# Changelog

Full version history of dsh-jina; the "Changelog" section of [README.en.md](./README.en.md) keeps only the latest release.

### 0.5.0 (2026-08-29)

- **fix** Compatible with the dsh 0.1.2-alpha.1 apiproxy refactor (`refactor(apiproxy)!: remove settings and credentials RPCs`, 2026-08-27): the browser half's credential RPC moves from the removed `connection.api.credentials.*` to the Typert Remote credentials namespace `ctx.remote.credentials` (`credentials/describe|set|unset`) — `describe` now takes a batch `refs[]`, `set`/`unset` take positional arguments, and the response envelope changes from `{result:{ok,value}}` to `{ok,value|error}`; the change event `credentials/updated` is renamed `credentials/reference-updated` (still forwarded by the same `remote` service).
- **fix** The `dsh.client` declaration drops the graph edge to `@deepseek-ai/dsh-client-runtime` (no longer a package in 0.1.2-alpha.1), keeping only the edge to `@deepseek-ai/dsh-api-remotes`; the bundle itself only consumes baseline `react` and requests no `external` modules.
- **fix** The subprocess handle no longer exposes an `exitCode` property: the exit code now comes from the `SubprocessOutcome` of `handle.done` (callers never consumed it anyway — pure contract alignment).
- **verify** Every other face was checked against the dsh 0.1.2-alpha.1 sources and remains compatible: `tools.register` full-JSON-Schema parameters pass the registration-time normalization (`normalizeRegisteredParameters`), the `output {schema, render}` contract is unchanged, and `credentials.resolve`, `webServer.register`, `settings.register` (duck-typed empty-namespace schema), `fs`/`sandboxPolicy`, the keyed `settings.plugin.item` slot, and the `window.__ModuleLoader__` client protocol all stayed the same.
- **docs** README/README.en.md changelog sections synced to 0.5.0.

### 0.4.0 (2026-08-18)

- **feat** The web search tool is renamed `jina_search` → `jina_web_search` so the tool name itself signals "web search", matching the built-in `web_search` naming signal. The description is rewritten task-first with a when-to-use trigger: it opens with what it returns (optional summary + official-source-first source list), a `Use this whenever...` clause states when to pick it (time-sensitive content, news, time filters) and the division of labor with the built-in `web_search` (broader general/engineering coverage); the `query` parameter description now points to the `time` parameter for recency-sensitive searches.
- **refactor** The tool's model-facing contract (name / description / parameters) is extracted into the pure data module `tool-contracts.js`, registered from `index.js` by spread; the settings-card note text is updated.
- **test** New `test/tools.test.js` (TDD, red first) pins the model-facing contract of `jina_web_search` — the rename, task-first opening, when-to-use trigger, division of labor with the built-in `web_search`, official-source/time-filter differentiators, query guidance, and a description-length budget.

### 0.3.1 (2026-08-18)

- **fix** Adapt to dsh's keyed-slot contract: the `settings.plugin.item` slot (Settings → Plugins → Configuration) is now keyed by the settings namespace a card edits (following the `tool.call.toolview` convention), and the section dispatches only cards for namespaces the host serves.
- **fix** The browser half registers the **Jina Tools** card under `key: 'jina-tools'`; the host half serves a matching `jina-tools` settings namespace (empty schema, zero-dependency — exists only to pair with the card; the API key still lives solely in the `JINA_API_KEY` credential seam), so the card renders only when both halves agree. Profiles without a settings provider never mount the injection and behave exactly as before.

### 0.3.0 (2026-08-15)

- **feat** `jina_primer` rework: returns real context — host clock (ISO time / unix / timezone / UTC offset), network facts (public IP + location, best-effort, degrades on failure) and Jina account status (identity / balance). Parsing/formatting extracted into a pure module `primer.js`; 17 zero-dependency unit tests added (`npm test`).
- **fix** Tool descriptions no longer list "API key required" as a prerequisite.

### 0.2.0 (2026-08-14)

- **feat** Dedicated academic search tools `jina_search_arxiv` / `jina_search_ssrn` (backed by `jina search --arxiv` / `--ssrn`); README gains a cross-comparison against the built-in `web_search`.
- **feat** The **Jina Tools** card now shows the current key's identity and balance live (via `/api/dsh-jina/primer`, manual refresh; auto re-check on save/clear).
- **feat** `jina_datetime` returns the extracted title / publish time instead of the raw JSON blob.
- **fix** Proper JSON Schema tool parameters; settings UI moved to the standard plugin config slot (Settings → Plugins → Configuration).
- **refactor** API key now managed through dsh's native credential seam (`JINA_API_KEY`).
- **fix** Robust schemastery resolution for `link:` installs; `package.json` subpath exported.
- **style** Fallback colors for settings-page theme tokens.
- **docs** English README with language switcher links; corrected install repo URL and key acquisition link.

### 0.1.0 (2026-08-14)

- **feat** Initial release: dsh-jina bundle — 10 `jina_*` model tools (search / read / screenshot / embed / rerank / classify / pdf / expand / datetime / primer) + settings-page API key UI.
