# Jupyter WebMCP Extension

A Chrome (Manifest V3) extension that adds
[jupyterlab-ai-commands](https://github.com/jtpio/jupyterlab-ai-commands) and
[jupyter-webmcp](https://github.com/jtpio/jupyter-webmcp) to a JupyterLab page at
runtime. Nothing is installed on the Jupyter server.

The design and the decisions behind it are in
[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## How it works

- The extension runs only on sites you enable from the toolbar popup. Nothing
  runs on other pages.
- A MAIN-world hook redirects JupyterLab's federated extension configuration to
  a runtime bundle shipped inside the extension. The runtime is a JupyterLab
  federated extension built from pinned sources in
  [runtime/src/vendor](./runtime/src/vendor).
- Native components listed in the page's federated extensions are left alone.
  Source-built native plugins are not yet verified and may conflict. Native
  `jupyterlab-ai-commands` releases earlier than 0.4 (`jupyterlite-ai`) are not
  supported.
- WebMCP is registered only when Chrome exposes `document.modelContext`. Start
  Chrome with `--enable-features=WebMCP` to get it. Without the flag, the
  extension reports WebMCP as unsupported and the AI commands still load.

## Build

Prerequisites: a current Node.js (development used v24), and
[`jupyter-builder`](https://github.com/jupyterlab/jupyter-builder) on `PATH`
(for example, `pip install jupyter_builder` in a virtualenv whose `bin/`
directory is on `PATH`).

```sh
npm ci
(cd runtime && npm ci)
npm run build         # builds runtime/, then dist/
```

Load `dist/` as an unpacked extension at `chrome://extensions` (developer mode).
The project is licensed under AGPL-3.0-only (see [LICENSE](./LICENSE)).
`dist/licenses/` holds the BSD-3-Clause license texts of the bundled upstream
code and the license for the Project Jupyter favicon used as the extension
icon; keep it in any package that is distributed.

`npm run build:e2e` writes `dist-e2e/`. That build grants host permissions for
all `http` and `https` origins, so the end-to-end harness needs no user gesture.
The production manifest is not changed.

## Use

1. Open a JupyterLab (or other supported) page.
2. Click the extension icon and enable the site. The popup shows the component
   status for the tab, including a live WebMCP tool count when active.
3. Connect an MCP client through WebMCP (Chrome with `--enable-features=WebMCP`).
   The tools are listed with `document.modelContext.getTools()`.

The options page lists enabled sites. It also holds the WebMCP settings as JSON:
`tools`, `disabledTools`, `blockedCommands`, `executionTimeout`
(seconds, 0 to 3600), and `maxResultLength` (integer, at least 1000). Invalid
values fall back to defaults. The default `blockedCommands` are
`apputils:run-all-enabled` and `apputils:run-first-enabled`.
These settings are shared by all enabled sites.
If the settings bridge cannot be reached, WebMCP tools do not start; reload
the page after checking that the extension is enabled.

Tokens, notebook content, and outputs are never stored or logged.

## Security

- Host access is requested per origin through `optional_host_permissions`.
  The production manifest has no static site access.
- The runtime runs with the page's authority, as any Jupyter extension does. Its
  tools can read and write files and run kernel code. Settings such as
  `blockedCommands` are guardrails, not a sandbox. An agent with Chrome DevTools
  Protocol or scripting access on the same page bypasses them.
- Settings and status cross the page boundary as DOM events. Page scripts can
  spoof them. The bridge validates the shape of status messages and caps their
  detail text. The service worker never lets page messages change enablement or
  permissions.
- The service worker accepts `enable`, `disable`, and `state` only from extension
  pages. It accepts `status` only from a content script of this extension, with
  a tab and a valid web origin.

## Supported hosts

Verified with the end-to-end scenario in Chrome for Testing 156 (see
[Testing](#testing)), with and without `--enable-features=WebMCP`:

| Host | Status |
| --- | --- |
| JupyterLab 4.0.0 | Passed |
| JupyterLab 4.2.7 | Passed |
| JupyterLab 4.4.10 | Passed |
| JupyterLab 4.6.6 | Passed |
| JupyterLite 0.6.4 (Pyodide kernel 0.6.1) | Passed |
| JupyterLite 0.7.6 (Pyodide kernel 0.7.2) | Passed |
| JupyterLite 0.8.7 | Passed |
| Notebook 7.6.5 (`/lab`) | Passed |

Also passed under a strict CSP (`script-src 'self' 'unsafe-eval'`, no
`'unsafe-inline'`, no `chrome-extension:`) on JupyterLab 4.6.6. JupyterLab
itself needs `'unsafe-eval'` (see [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) §7).

Type-checked (not run in a browser) against `@jupyterlab/*` 4.0.8 and 4.4.7
typings, and against the lockfile versions. The type-only patches are listed in
[runtime/src/vendor/SOURCES.json](./runtime/src/vendor/SOURCES.json).

Not yet verified: Notebook 7.0.x, JupyterLite 0.4 and 0.5, and JupyterLab or
JupyterLite releases later than those listed. Treat them as unsupported until
they pass the scenario.

Embedded frames: a same-origin iframe on an enabled site runs the runtime. A
cross-origin iframe runs it only with `allow="tools"`, and only when the
iframe's origin and every ancestor origin are enabled.

## Testing

```sh
npm run typecheck
npm test                       # unit tests (vitest)
```

The end-to-end harness drives real Chrome against running JupyterLab servers.
Use a disposable server root, because the scenario creates and deletes notebooks
and files.

```sh
JWE_E2E_URLS=http://localhost:8888,http://localhost:8889 \
JWE_CHROME=/path/to/chrome \
PATH=/path/to/jupyter_builder/bin:$PATH \
npm run test:e2e
```

`JWE_E2E_URLS` is required. `JWE_CHROME` is optional, for when Playwright's
bundled browser is absent. The harness checks that every tool in the §8 scenario
works, that WebMCP is marked unsupported without the flag, and that a site that is
not enabled gets no runtime.
