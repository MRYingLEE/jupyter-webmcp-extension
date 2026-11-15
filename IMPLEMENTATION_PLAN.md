# Implementation plan: runtime WebMCP for Jupyter

## 1. Goal and scope

Build a Chrome Manifest V3 extension that adds `jupyterlab-ai-commands` and
`jupyter-webmcp` to an existing Jupyter page **at runtime**, without
installing a server package or rebuilding the Jupyter site. Each component is
added only when the page does not already provide it.

| Target | Support level | Notes |
| --- | --- | --- |
| JupyterLab >= 4.0.0 | Primary | The lower bound comes from `jupyterlab-ai-commands`. |
| JupyterLite >= 0.6, lab UI | Primary | Lite 0.6, 0.7, and 0.8 are built on JupyterLab 4.4, 4.5, and 4.6. The configuration is assembled in the browser (see §4.2). Lite 0.4 and 0.5 (JupyterLab 4.2 and 4.3) are a stretch goal. |
| Jupyter Notebook >= 7.0, JupyterLite notebooks UI | Secondary | Supported only after separate validation; these frontends show one document per page (see `jupyter-webmcp/docs/frontends.md`). |

Non-goals:

- Polyfilling WebMCP: the browser must expose `document.modelContext`, and
  Jupyter must be served from a secure context.
- Replacing, overriding, or duplicating natively installed plugins.
- Generic tool interception or user-defined script injection, as provided by
  `webmcp-tool-overrides`.

Pinned references examined: `jupyter-webmcp` `9b7a190` (0.1.0),
`jupyterlab-ai-commands` `4721ac8` (0.4.0), and `webmcp-tool-overrides`
`62a52ab`. These sibling checkouts are build inputs, not files the extension
can expect on a user's machine.

## 2. Verified facts that shape the design

1. **JupyterLab loads extensions from page configuration.** In 4.x,
   `bootstrap.js` reads `federated_extensions` from the
   `#jupyter-config-data` script and runs
   `loadScript(<fullLabextensionsUrl>/<name>/<load>)`. It then initializes
   `window._JUPYTERLAB[<name>]` with the host's webpack share scope.
   `index.js` calls `container.get('./extension')`, skips disabled plugins,
   and calls `registerPluginModule`. Failures are collected with
   `Promise.allSettled`, so a broken injected extension is logged without
   stopping the page. Source: `jupyterlab/jupyterlab` `v4.0.0`, files
   `dev_mode/bootstrap.js` and `dev_mode/index.js`.
2. **Shared singletons solve class identity.** `@jupyter/builder` marks core
   packages as `singleton` with `import: false`. A prebuilt extension
   therefore uses the host's `@jupyterlab/*` and `@lumino/*` modules,
   tokens, and classes. This lets the upstream `instanceof NotebookPanel`
   and `instanceof DocumentWidget` checks work on host widgets. A
   mismatched `requiredVersion` only warns and still uses the host
   singleton, so API compatibility must be checked separately (§5).
3. **No app global is needed.** `window.jupyterapp` exists only with
   `devMode` or `exposeAppInBrowser`, so production pages cannot rely on it.
   A normal federated plugin receives `app` and its required tokens through
   `activate`.
4. **JupyterLite rewrites its configuration in the browser.**
   `app/config-utils.js` (identical `main()` in `v0.4.0` through `v0.8.0`) merges `jupyter-lite.json` and parent
   configurations, writes the result to `#jupyter-config-data.textContent`,
   and then appends the main bundle script. A page's static HTML is therefore
   not its final configuration.
5. **JupyterLab 4.0 has the needed Lumino APIs.**
   `@jupyterlab/application@4.0.0` depends on `@lumino/commands ^2.1.1`,
   which has `describedBy`. It also depends on
   `@lumino/application ^2.1.1`, which has `hasPlugin` and
   `isPluginActivated`. Other APIs used by the upstream code must still be
   audited because `jupyter-webmcp` declares `@jupyterlab/* ^4.6`.
6. **The settings schema will be missing.** The `jupyter-webmcp:plugin`
   activation requires `settingRegistry.load('jupyter-webmcp:plugin')`.
   When it is injected, the server or Lite settings API has no schema, so
   loading fails and the upstream plugin registers no tools. The runtime
   must provide its own settings source (§4.4).
7. **The ownership and dependency model is fixed upstream.** WebMCP tools
   are registered through `document.modelContext.registerTool(tool,
   {signal})` and removed by aborting the signal. The default tools exist
   only while their backing command exists, and `ToolManager` reacts to
   `commandChanged`. The pip package `jupyter_webmcp` installs
   `jupyterlab-ai-commands`. Separately, `jupyterlite-ai` 0.20.1 pins
   `jupyterlab-ai-commands < 0.4` (from upstream `frontends.md`), so an
   older AI-commands package is a realistic host state.

## 3. Approach: a virtual federated extension

Do not search for the application object or invoke private loaders. Package
one prebuilt JupyterLab federated extension with the browser extension, then
inject it into the page's own extension list so that Jupyter loads it as if it
were installed.

```text
content (MAIN, document_start)              Jupyter bootstrap
 ├─ read final #jupyter-config-data   ─┐
 ├─ decide what is missing (§4.3)      │
 ├─ append the runtime entry to        ├──> loadScript(<labext>/<runtime>/<load>)
 │  federated_extensions               │        │ src mapped to the web-accessible
 └─ map that one script URL ───────────┘        ▼ chrome-extension:// copy
                                            container.init(host share scope)
                                            registerPluginModule(runtime plugins)
                                                 │ activate(app, IDocumentManager, ...)
                                                 ▼
                                    AI commands (if missing) + WebMCP (if missing)
```

### Repository layout

```text
manifest.json
src/
  background/        service worker: permissions, per-origin enablement, badge
  content/
    bootstrap-main.ts      MAIN world: config injection and URL mapping only
    bridge-isolated.ts     ISOLATED world: settings and status relay
  popup/, options/   site enablement, status, WebMCP settings
runtime/             JupyterLab extension package built with @jupyter/builder
  src/index.ts       runtime plugins (§4.4)
  src/settings.ts    ISettings-compatible adapter
vendor/              pinned upstream sources (submodules or tarball and lockfile)
patches/             minimal, documented upstream patches, if any
scripts/build.mjs    build runtime -> labextensions/<name>/, then bundle the extension
tests/
```

## 4. Components

### 4.1 Runtime extension package

- Create `@jupyter-webmcp-extension/runtime`, a JupyterLab extension package
  that depends on the pinned upstream packages and is built with
  `@jupyter/builder`. Its output is `package.json` plus
  `static/remoteEntry.<hash>.js` and chunks. Read the entry path from
  `jupyterlab._build.load`.
- Prefer importing upstream modules over copying them, for example
  `registerFileCommands`, `registerNotebookCommands`,
  `registerKernelCommands`, `WebMCPRegistry`, `ToolManager`,
  `KernelCommands`, and `getModelContext`. If an upstream package does not
  publish a needed `lib/*` module, build from the pinned source and keep any
  patch small, documented, and offered upstream.
- Use the extension's own plugin IDs (for example
  `jupyter-webmcp-extension:ai-commands`). This avoids colliding with
  native IDs and keeps `hasPlugin('jupyter-webmcp:plugin')` meaning "natively
  installed". Use a container or package name that cannot collide with an
  installed package.
- Declare `@jupyterlab/* ^4.0.0` (and the matching `@jupyterlab/services
  ^7.0.0`) so that the shared-scope negotiation matches every supported host.

### 4.2 Page bootstrap (MAIN world, `document_start`)

1. Run only on origins the user enabled (§6) and only in the top frame by
   default.
2. Find the **final** `#jupyter-config-data`:
   - Server-rendered JupyterLab or Notebook: intercept the script element as
     the parser inserts it, before `bootstrap.js` first calls `getOption`.
   - JupyterLite: observe the element's `textContent` rewrite by
     `config-utils.js`. Edit it before the appended main bundle executes.
   - Accept only pages whose configuration contains `federated_extensions`
     and an app name or version. URL patterns alone are not sufficient.
3. Decide what is missing (§4.3). If nothing is missing, do nothing.
4. Append one entry,
   `{name, load, extension: './extension', style?}`, to
   `federated_extensions`. Also pass the decision and settings to the
   runtime through a namespaced, non-privileged data channel, such as an
   extra config key. Do not pass Chrome APIs.
5. Map only the exact URL `<fullLabextensionsUrl>/<name>/<load>` to the
   corresponding `chrome.runtime.getURL(...)` resource. Implement this with
   either a narrow hook on the script that the bootstrap inserts or a
   per-origin `declarativeNetRequest` redirect. Choose the method in the
   spike (§7). With webpack `publicPath: 'auto'`, chunks resolve relative to
   the entry script, so verify that they also load from the extension.
6. Expose the runtime files through `web_accessible_resources`, preferably
   with `use_dynamic_url: true`.
7. On failure (malformed config, unexpected bootstrap timing, CSP, or a
   blocked load), leave the page untouched and report a diagnostic. The page
   must behave exactly as it would without the extension.

Already loaded tabs cannot be modified this way. The popup offers "Reload
to enable."

### 4.3 Conditional decision

Make a **static decision** before bootstrap using the configuration. Then
make a **runtime confirmation** inside the injected plugins using
`app.hasPlugin` and `app.isPluginActivated`, after `app.started`.

| AI commands native | WebMCP native | Inject | Runtime behavior |
| --- | --- | --- | --- |
| Present (>= 0.4) | Present | Nothing | None. |
| Present (>= 0.4) | Absent | Runtime, WebMCP part only | The upstream manager discovers the native commands. |
| Absent | Present | Runtime, AI part only | The native `ToolManager` picks up the new commands through `commandChanged`. |
| Absent | Absent | Runtime, both parts | Add the AI commands, then start the WebMCP manager. |
| Present (< 0.4) or unknown version | Any | Treated as Present (>= 0.4): AI part never; WebMCP part as for the row above | **Out of scope.** No version check, warning, or schema-based tool disabling. Native commands are never overwritten. |
| Disabled through `disabledExtensions` or locked | Any | Nothing for that component | Respect the administrator's intent and show the reason. |

Rules:

- Detect "native" from the `federated_extensions` names
  (`jupyterlab-ai-commands`, `jupyter-webmcp`) and the source-built
  extension list where it is exposed. Get versions from
  `<labextensions>/<name>/package.json`, fetched by the isolated world or by
  the runtime with the page's own origin.
- In each runtime plugin, check first and stop on conflict. The AI part must
  never call `addCommand` for an existing ID, because Lumino throws on
  duplicates. If any `jupyterlab-ai-commands:*` command already exists
  unexpectedly, skip the whole AI part instead of registering a partial set.
- Never start a second `ToolManager` when the native WebMCP plugin is
  present, including when the native plugin failed. Report the native
  failure instead, because its policy may intentionally block tools.
- Treat the static configuration as advisory. A source-built extension that
  is absent from `federated_extensions` is caught by the runtime check, and
  the injected part then stands down.

### 4.4 Runtime plugins

- **AI-commands plugin** (`requires: [IDocumentManager]`, optional editor
  tracker and notebook tracker): mirror the upstream `activate` function,
  but without its settings load because the schema does not exist. Leave
  argument schemas, results, and errors unchanged.
- **WebMCP plugin** (optional `ILabShell`, `IDefaultFileBrowser`,
  `ICommandPalette`, `IStatusBar`, and `ITranslator`): mirror the upstream
  `activate`, replacing `settingRegistry.load(PLUGIN_ID)` with a
  `RuntimeSettings` adapter that implements the members `ToolManager` uses
  (`composite`, `default(key)`, and `changed`).
  - Defaults are copied from the pinned `schema/plugin.json`, including
    `blockedCommands`, `apputils:run-all-enabled`, and
    `apputils:run-first-enabled`.
  - User values come from extension storage per origin. Validate them with
    the same schema and the upstream `validateSpec`. Invalid values fall
    back to the defaults and are reported, matching upstream behavior.
  - Live updates arrive over the bridge, and the adapter emits `changed`.
  - There is no `overrides.json` equivalent. Document this clearly.
    Administrator-enforced policy remains a native-install feature.
  - Register `jupyter-webmcp:interrupt-kernel` and `restart-kernel` only if
    they are absent. Keep the upstream "Show WebMCP Tools" command and
    status item when the IDs are free, and mirror the status to the
    extension badge.
  - If `getModelContext()` is `null`, register nothing and report
    "WebMCP unavailable," as upstream does.
- Wait for `app.restored` with a bounded timeout. Every failure path calls
  `manager.fail(reason)` or the equivalent and reports the reason through the
  bridge.

### 4.5 Extension UI and storage

- The popup shows the origin, frontend and version (`appName` and
  `appVersion`), the decision per component (native, injected, skipped, or
  error), WebMCP availability, the registered tool count, and reload or
  enable actions.
- The options page holds per-origin enablement and WebMCP settings, edited
  as JSON validated against the schema. Never store or log tokens, notebook
  content, or outputs.

## 5. Compatibility work for JupyterLab 4.0 to 4.5 (and JupyterLite 0.6 and 0.7)

1. **Type audit:** compile the runtime and the imported upstream sources
   against the `@jupyterlab/* 4.0.x` typings. Compilation errors identify
   the 4.6-only APIs. Repeat for 4.4 (the JupyterLite 0.6 base) and the
   latest version.
2. For each incompatibility, prefer a feature check with a fallback in a
   small shim module. Fall back to a documented patch only when necessary,
   and offer the fix upstream. Do not bundle newer `@jupyterlab/*` copies,
   because that would break token and class identity.
3. **Runtime audit:** run the upstream unit tests and the integration
   matrix (§8) against each host line. The type checker cannot catch
   behavioral differences, such as dialog DOM or `describedBy` contents.
4. Build one runtime artifact for all hosts if possible. Use per-range
   artifacts only if a shim cannot bridge a difference; the bootstrap can
   select an artifact from `appVersion`.

## 6. Security

- Request no static host access to all sites. Request
  `optional_host_permissions` and enable sites explicitly per origin
  (`localhost`, a JupyterHub domain, or a Lite site). Register the MAIN-world
  script dynamically through `chrome.scripting.registerContentScripts` for
  enabled origins only.
- The runtime runs with the page's authority, as any Jupyter extension does.
  Its tools can read and modify files and run kernel code. Document that
  settings are guardrails, not a sandbox (see upstream `security.md`), and
  that an agent with CDP or scripting access bypasses them.
- Keep the MAIN-world script minimal and data-only. Treat page messages as
  untrusted: validate their shape, origin, and frame, and never let them
  change permissions, enablement, or settings.
- Package all code locally and reproducibly from pinned sources. Do not use
  remote code, `eval`, or user scripts. Preserve the BSD-3-Clause notices
  of both Jupyter projects, and the Apache-2.0 notice if any
  `webmcp-tool-overrides` code is reused. The project is AGPL-3.0-only (see
  `LICENSE`).
- **Bundle license audit (observed):** the lockfiles are not enough, so the
  built output was checked too. `dist/` and `runtime/labextension/` contain
  no code from elkjs (EPL-2.0), dompurify (MPL/Apache), or mermaid, and no
  EPL text, so `third-party-licenses.json` stays empty. Those packages are
  reached only through `@jupyterlab/notebook` and the Notebook mermaid plugin,
  which the runtime shares with the host. `dist/licenses/` contains the two
  vendored BSD texts. Repeat this check on each release.

## 7. Delivery phases

1. **Spike: the go or no-go gate.** Load a trivial federated plugin that logs
   `app.version` into unmodified production JupyterLab 4.0.x and 4.6.x,
   JupyterLite 0.6.x and 0.8.x, and Notebook 7. Prove all of the following:
   - The configuration edit happens before it is read.
   - The URL mapping works for the entry and its chunks.
   - The host share scope is used: `app.commands` is the host's registry,
     and `instanceof NotebookPanel` holds for a host notebook.
   - The page still works if the runtime is missing.

   Record the behavior under CSP, including a strict `script-src`
   configuration. If a host variant fails, mark it as unsupported, with a
   diagnostic.

   **Result (observed; scratch spike copy, not this repository):**
   - (a) config edit before read, (b) URL map with chunks, and (d) missing
     runtime pass on JupyterLab 4.0.0 and 4.6.6, JupyterLite 0.6.4 and 0.8.7,
     and the Notebook 7.6.5 notebook page. (d) on the Notebook 7 `/tree` file
     browser shows an error that also occurs without the extension.
   - (c) host commands and `instanceof NotebookPanel` pass on those hosts. The
     check fails on Notebook 7 `/tree`, which opens no notebook, so it does not
     apply to that page.
   - `window.jupyterapp === app` was false on every host, and the reason is not
     known. Host identity therefore rests on the `@lumino/commands` `instanceof`
     check and the registry contents.
   - The spike logged status-0 requests for a `chrome-extension://` origin with
     a UUID that does not match the extension ID. The resources still loaded
     with status 200. This is not investigated.
   - CSP: `script-src 'self'` alone breaks JupyterLab 4.6.6 itself (an inline
     script is blocked, and `@jupyterlab/apputils-extension:settings` throws an
     `EvalError`). With `script-src 'self' 'unsafe-eval'`, the shell renders,
     and the runtime loads with its tools. The earlier "strict" host (port
     8892, `'unsafe-inline' 'unsafe-eval' blob:`) was not strict.
2. **Skeleton:** the manifest, optional permissions, dynamic script
   registration, the bridge, the popup, the build pipeline that vendors the
   runtime, and lint and unit-test setup.
3. **AI part:** the runtime AI plugin and the conflict checks. Validate file,
   notebook, and kernel commands on 4.0 and 4.6.
4. **WebMCP part:** the settings adapter, the manager, kernel commands, the
   status, and the conditional matrix (§4.3).
5. **Compatibility and hardening:** the §5 audits, the Lite and Notebook
   specifics, failure diagnostics, and accessibility of the UI.
6. **Release:** a reproducible build, a license audit, documentation for
   setup, clients, settings, security, and the supported matrix, and a
   Chrome Web Store package.

## 8. Verification

- **Unit tests:** configuration parsing and injection for both server and
  Lite configuration shapes; the decision table, including disabled,
  older-version, and unknown cases; settings validation and merging;
  idempotency on reload.
- **Integration tests (Playwright, Chrome with `--enable-features=WebMCP`):**
  - Hosts: unmodified JupyterLab 4.0.x, 4.2.x, 4.4.x, 4.6.x, and the latest
    version; JupyterLite 0.6.x, 0.7.x, 0.8.x, and the latest version, each
    with the Pyodide kernel that matches it; Notebook 7.0.x and 7.6.x.
  - Fixtures: neither component installed; AI commands only; both
    installed natively; and WebMCP only (a controlled build, since pip pulls
    in AI commands). The native AI commands earlier than 0.4 (`jupyterlite-ai`)
    are out of scope and are not tested.
  - Assert the tools through WebMCP itself, using Chrome DevTools or
    `chrome-devtools-mcp` `list_webmcp_tools` and `execute_webmcp_tool`, not
    only through logs. Native pages must show exactly the native tool set.
    Injected pages must show the five built-in tools plus each default tool
    whose command exists.
- **End-to-end scenario per host:**
  1. `get_context`
  2. `create_notebook`
  3. `add_cell`
  4. `read_notebook` on an unsaved cell
  5. `run_cell` with its output
  6. `save_notebook`
  7. `read_file` and `write_file`
  8. `run_code`, then `interrupt_kernel` and `restart_kernel`
  9. A blocked command through `execute_command`
  10. A dialog through `answer_dialog`
  11. A long call through `wait_for_result`
- **Negative cases (observed):** `scripts/e2e.mjs` covers these on JupyterLab
  4.0.0, 4.2.7, 4.4.10 and 4.6.6, JupyterLite 0.6.4, 0.7.6 and 0.8.7, and
  Notebook 7.6.5 (Chrome for Testing 156). Run 5 passed on the seven hosts
  listed in §8 Observed, with the iframe, two-tab, reload and missing-runtime
  checks. The strict-CSP and Notebook 7 checks ran separately, as described
  below:
  - WebMCP disabled or unsupported, site not enabled, and a non-Jupyter page
    (`/api/status`): no runtime status and no tools.
  - Two tabs and a page reload: the runtime is active in each.
  - Missing runtime file: JupyterLab still renders, and a failed `runtime`
    status is recorded. The popup shows it and the toolbar badge shows `!`.
    The popup was not checked visually.
  - Strict CSP: a local proxy serves JupyterLab 4.6.6 with
    `script-src 'self' 'unsafe-eval'`, with no `'unsafe-inline'` and no
    `chrome-extension:`. The check asserts both, and the runtime is active
    with its tools present. `'unsafe-eval'` is required by JupyterLab itself
    (§7).
  - Iframes: a cross-origin Lite iframe, served from a loopback parent, fails
    visibly without `allow="tools"` ("The embedding frame does not allow the
    tools permission"). It also fails when the parent origin is not enabled
    ("Runtime is not enabled for this frame."). A same-origin iframe runs the
    runtime with or without `allow`, because Chrome's default feature policy
    allows tools for same-origin frames. This differs from the earlier wording
    of this item, and §9 records it as a decision.
  - Not covered: an extension reload during a session. Playwright's
    persistent context unloads the extension on reload, so only page reload is
    tested. A cross-origin JupyterLab cannot be framed without changing its
    `frame-ancestors` header, so only Lite is tested as the cross-origin child.
- **Observed (this change):** each injected host lists 21 tools: the five
  built-ins (`get_context`, `list_all_commands`, `execute_command`,
  `answer_dialog`, `wait_for_result`) and 16 default AI-command tools. The
  harness asserts the built-in names on every host. The full run (run 5)
  passed on JupyterLab 4.0.0, 4.2.7, 4.4.10 and 4.6.6, and on JupyterLite
  0.6.4 (`jupyterlite-core==0.6.4` with `jupyterlite-pyodide-kernel==0.6.1`,
  because no 0.6.4 kernel exists), 0.7.6 (kernel 0.7.2) and 0.8.7. A later
  run passed on Notebook 7.6.5 at `/lab` (`/tree` is the file browser, which
  opens no notebook, so it is not a test host). Not yet run: Notebook 7.0.x,
  JupyterLite 0.4 and 0.5, and releases later than those listed.

## 9. Risks and open questions

| Risk | Mitigation |
| --- | --- |
| Configuration edits race with the bootstrap, especially in Lite or future bootstrap changes | Spike gate, per-version tests, and a fail-safe that does nothing on timing doubt |
| A page CSP blocks `chrome-extension://` scripts | Detect the failure and report it. Evaluate the `declarativeNetRequest` redirect path. No workaround that weakens the page CSP |
| 4.6-only APIs in upstream code | §5 audits, shims, and upstream patches |
| No `overrides.json` policy for injected WebMCP | Document it, and recommend the native install for managed deployments |
| Upstream drift | Pin versions, use Renovate-style update pull requests that rerun the matrix, and track upstream issues (`frontends.md`, "Upstream issues") |
| Older Lite runtimes (0.6, 0.7) behave differently from 0.8, for example in Pyodide kernel interrupts and restarts, kernel listing, or browser-storage contents | Run the end-to-end scenario on each Lite line. Treat differences as known limitations, not as reasons to drop the version, unless core tools fail |
| Hub or proxy URL layouts (`/user/<name>/lab`) | Derive everything from `fullLabextensionsUrl` and never hard-code paths |
| Same-origin iframe runs the runtime without `allow="tools"`. The `allFrames` registration also makes this a behavior change | Chrome's default feature policy allows same-origin frames, and the `allow` gate applies to cross-origin frames only. Decide whether to require `allow` for every embedded frame |
| Failures are visible only in the popup and on the toolbar badge, not on the page | Keep the badge (`!`) and the popup status. Add an in-page notice only if silent failure is unacceptable |
| The embedded grant is async (`chrome.storage.local`), so a late grant can miss the injection | The frame fails closed with "Runtime is not enabled for this frame." A page reload retries. Not tested under real timing |
| Removed iframes leave their status entries until the tab closes or is cleared | Document it. Frame-keyed status is cleared with the tab |
| A same-origin subframe's tools appear on the top document | Observed: the parent lists 0 tools without the subframe and 21 with it. This stays within one origin |
| JupyterLab 4.6.6 needs `'unsafe-eval'` under a strict CSP | Its settings plugin evaluates code, so `script-src 'self'` alone breaks the host. The extension cannot work around this without weakening the page CSP |

Open questions to settle in the spike: the URL-mapping method (script hook or
`declarativeNetRequest`); one runtime artifact or per-range artifacts; and
whether to upstream an optional settings fallback to `jupyter-webmcp` so that
the adapter becomes unnecessary.

### Pending issues

These items are not verified. Each one is a gap, not a known failure.

1. **Spike not run as a separate plugin in this repository.** The §7 spike ran
   in a scratch copy. The repository has no spike plugin.
2. **Extension reload during a session is untested.** Playwright's persistent
   context unloads the extension on reload. Only page reload is tested.
3. **Popup and badge are not checked visually.** The `!` badge and the failure
   text in the popup are only checked through status data.
4. **Hosts not run:** Notebook 7.0.x, JupyterLite 0.4 and 0.5, and JupyterLab
   and JupyterLite releases later than those listed in §8.
5. **Notebook 7 `/tree` fails spike check (c).** `/tree` is the file browser and
   opens no notebook, so the check may not apply. The harness has no notebook
   page check for Notebook 7 beyond `/lab`.
6. **Cross-origin JupyterLab child is untested.** Its `frame-ancestors` header
   cannot be changed, so only Lite is tested as the cross-origin child (§8).
7. **Strict CSP is tested on one host only.** The check ran on JupyterLab 4.6.6
   through a local proxy with `script-src 'self' 'unsafe-eval'`. It was not run
   on other versions or on a real server with a strict policy.
8. **Embedded grant race is untested under real timing** (see the grant risk in
   this section).
9. **`window.jupyterapp === app` is false on every host.** The reason is not
   known. Host identity rests on the `@lumino/commands` `instanceof` check and
   the registry contents.
10. **Status-0 requests from the spike are not investigated.** They were for a
    `chrome-extension://` origin whose UUID did not match the extension ID. The
    resources still loaded with status 200.
11. **Federation warnings on JupyterLab 4.0.0.** Shared-singleton version
    mismatches are logged, but they do not block loading. The cause and any
    effect on the shared singletons are not analysed.
12. **Embedded-frame policy is not confirmed.** Whether the ancestor-enabled rule
    matches the intent, and whether badge-only failure visibility is enough, are
    open decisions (see the risk rows above).
13. **Source-built native plugins are not confirmed.** The runtime currently
    uses the upstream plugin IDs and has no `hasPlugin`/`isPluginActivated`
    confirmation. A native plugin absent from `federated_extensions` can
    conflict at registration, before the runtime's command conflict check.
    Native and source-built fixture coverage is still needed.
14. **Settings are global, not per origin.** The options page and bridge use
    one storage key for all enabled sites, unlike the per-origin design in
    §4.4. Users should not assume different sites have independent settings.
15. **Concurrent status reports can overwrite each other.** The service worker
    updates shared session-storage objects with unsynchronized read-modify-write
    operations. Reports from different components or frames can race, causing
    incomplete popup or badge status.
