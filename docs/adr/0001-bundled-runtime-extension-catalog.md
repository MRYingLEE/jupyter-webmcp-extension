# Bundle curated runtime extension assets

**Status:** Accepted

The Chrome extension will provide a curated catalog of version-pinned, browser-side Jupyter front-end extensions, beginning with Anywidget, and inject them at Jupyter startup without changing the Jupyter server or kernel. Bundling avoids runtime fetching of arbitrary code and works offline; the trade-off is that catalog and asset updates require a Chrome extension release, and each extension must be verified for each supported JupyterLab and JupyterLite version. The extension catalog is curated and version-pinned. Users opt in per extension for the current tab, except that anywidget 0.11 is selected by default. A selection applies when the user reloads the page; the popup may offer a reload button with an unsaved-work warning, but never reloads automatically.

## Consequences

- Each bundled build records its package version, source commit, and license.
- The existing AI commands and WebMCP become built-in components that share the catalog's decision model: each component is injected, deployment-provided, disabled by the deployment, unsupported for this Jupyter version, or failed.
- A deployment-provided or deployment-disabled extension is never injected or overridden.
- Catalog dependencies are injected only when the deployment lacks them. Anywidget depends on an ipywidgets 8 widget manager; an incompatible deployment-provided widget manager is reported, not replaced.
- Selections are stored in `sessionStorage` per tab and per Jupyter instance, and are read synchronously by the MAIN-world hook before the page loads its configuration. A frame that runs the runtime reads its own `sessionStorage`, so a frame with no record gets the default selection (anywidget 0.11). The popup writes only the top-level tab's record.
- Kernel prerequisites are reported with the install command for the current Jupyter instance, but are never installed.
