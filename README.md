# Jupyter WebMCP Extension

A Chrome (Manifest V3) extension that adds
[jupyterlab-ai-commands](https://github.com/jtpio/jupyterlab-ai-commands) and
[jupyter-webmcp](https://github.com/jtpio/jupyter-webmcp) to a JupyterLab page at
runtime. Nothing is installed on the Jupyter server.

The design and the decisions behind it are in
[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

> **Download:** [jupyter-webmcp-extension.zip](./jupyter-webmcp-extension.zip)  
> Unzip the file, open `chrome://extensions`, enable **Developer mode**, and
> choose **Load unpacked**. Select the extracted folder containing
> `manifest.json`.

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
- The extension catalog ([scripts/catalog-pins.json](./scripts/catalog-pins.json))
  lists front-end extensions you can inject per tab, currently anywidget 0.11
  and 0.10. Each one is built from a pinned source into `runtime/catalog/`, and
  the popup shows which catalog entries are active. Each anywidget line matches
  the kernel's anywidget minor version. Catalog entries never replace an
  extension the deployment already provides.
- Runtime packages: the options page loads a JupyterLab extension from PyPI by
  package name and version, for example `anywidget` and `0.11.0`. The extension
  downloads the package's universal wheel (`py3-none-any`), checks it against
  the sha256 that PyPI publishes, and stores the labextension only when the check
  passes. Each loaded package is a separate item in the popup, on until you
  uncheck it. A package is injected as a federated extension, and it has no bundled
  fallback. The package must contain exactly one JupyterLab extension. Packages
  need the browser to reach `pypi.org` and `files.pythonhosted.org`, which the
  options page asks permission for. The verified files are kept per origin in
  `localStorage`, so later page loads use them before the service worker replies.
  After a refresh, the first load of an origin still uses the previously stored
  build. If the page's CSP blocks a verified package, the tab does not inject it
  until the verified version changes.
- A catalog selection is kept in `sessionStorage` for the tab and the Jupyter
  instance (origin and base URL). Anywidget 0.11 is selected by default, so an
  instance with no saved selection gets it; saving with no extensions checked
  opts the instance out. A selection is cleared when the tab closes and does
  not apply to other instances. A frame that runs the runtime reads its own
  `sessionStorage`, so a frame with no saved record gets the default selection.
  The popup selection applies only to the top-level tab.

## Build

Prerequisites: a current Node.js (development used v24), and
[`jupyter-builder`](https://github.com/jupyterlab/jupyter-builder) on `PATH`
(for example, `pip install jupyter_builder` in a virtualenv whose `bin/`
directory is on `PATH`).

```sh
npm ci
(cd runtime && npm ci)
ANYWIDGET_SOURCE=/path/to/anywidget npm run build:catalog   # once, or after changing scripts/catalog-pins.json
npm run build         # builds runtime/, then dist/ (requires runtime/catalog/)
npm run package       # builds dist/ and creates jupyter-webmcp-extension.zip
```

`build:catalog` builds each pinned catalog entry from the local anywidget
checkout in `ANYWIDGET_SOURCE` (for the 0.10 line, the pinned commit must be
present in that checkout). It writes `runtime/catalog/<id>/`, which is
git-ignored. `build` does not run `build:catalog` for you.

The ZIP is ready to unzip and load as an unpacked extension. It contains the
production build (without source maps). `npm run build` alone creates `dist/`.
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

The catalog scenario is verified on JupyterLab 4.6.6: anywidget 0.11 (kernel
anywidget 0.11.0) through the end-to-end harness, and anywidget 0.10 (kernel
anywidget 0.10.0) by a manual notebook check. JupyterLite is not yet verified
for the catalog. Other JupyterLab versions are untested for the catalog.

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
not enabled gets no runtime. On non-Lite URLs it also checks the default
selection (anywidget 0.11 for a tab with no saved selection), an opt-out with the
catalog entry turned off, that the other tab and other instances are unaffected, and that
a notebook anywidget renders. That check needs the anywidget 0.11 package in
the server's kernel environment and `runtime/catalog/anywidget-0.11` built.

The JupyterLab server itself must not have anywidget's labextension installed.
If it does, the catalog marks `anywidget-0.11` as a conflict and the check fails.
The server must also run with `--ServerApp.disable_check_xsrf=True`, because the
harness writes a notebook with an unauthenticated `PUT /api/contents`.
