# Jupyter Extension Injection

This context describes browser-side extensions added to an existing Jupyter application by the Chrome extension.

## Language

**Jupyter instance**:
A Jupyter application identified by its origin and base URL, such as a JupyterLab server or a JupyterLite site.
_Avoid_: Environment, when referring only to the browser-loaded application

**Front-end extension**:
A plugin that extends the Jupyter user interface, rather than installing software into its Python kernel or server.
_Avoid_: Jupyter package, when the package's runtime role is unclear

**Runtime-injected extension**:
A front-end extension made available to a Jupyter instance by the Chrome extension without installing it into the Jupyter deployment.
_Avoid_: Installed extension, which can imply deployment-level installation

**Extension catalog**:
The curated set of front-end extensions users may choose to runtime-inject.
_Avoid_: Marketplace, which suggests an open package registry

**Catalog dependency**:
A front-end extension in the extension catalog that is injected only because a selected entry needs it and the deployment does not provide it.
_Avoid_: Bundled requirement

**Built-in component**:
A runtime-injected extension the Chrome extension provides on enabled sites without per-tab selection, such as AI commands and WebMCP.
_Avoid_: Default catalog entry

**Deployment-provided extension**:
A front-end extension already supplied, or explicitly disabled, by the Jupyter deployment.
_Avoid_: Native extension, which can also refer to source-built plugins

**Kernel prerequisite**:
A package the notebook kernel must provide for a front-end extension to be useful, such as the Python anywidget package.
_Avoid_: Dependency, which here means a catalog dependency

**Anywidget version line**:
One minor release series of anywidget, such as 0.11, which must match between the kernel and the browser.
_Avoid_: Anywidget version, when a minor series is meant

**Tab-scoped selection**:
The extensions selected for a Jupyter instance in one browser tab, retained across reloads in that tab but not across tab closure or a change to another Jupyter instance. An instance with no saved selection uses the default selection.
_Avoid_: Persistent installation

**Default selection**:
The catalog extensions a Jupyter instance uses when its tab has no saved selection for it. Currently anywidget 0.11. Saving an empty selection opts the instance out.
_Avoid_: Built-in extension, which means a component that is always injected

**Verified compatibility**:
A tested pairing of a catalog extension with a Jupyter application and version.
_Avoid_: Supported, unless the specific pairing has been verified
