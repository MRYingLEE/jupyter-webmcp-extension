# Bundle several anywidget version lines

**Status:** Accepted

The Python anywidget package asks the browser for its own minor version line (for example `~0.9.*`), so a single browser build of the latest local checkout cannot render widgets created by kernels with an older anywidget. The Anywidget catalog entry therefore bundles the latest line, built from the local checkout, plus a small set of verified earlier lines. If the kernel requests a line that is not bundled, the extension reports the mismatch instead of loading a mismatched version.

Each line is built from a pinned commit of the local checkout (see [scripts/catalog-pins.json](../../scripts/catalog-pins.json)). Only the federation name and plugin id are renamed per line; the widget name `anywidget` is unchanged, because Python looks it up by that name. Both lines can register side by side in the widget registry.

The anywidget plugin requires the Jupyter widget registry. Plain deployments may lack it, so the catalog also bundles `jupyterlab_widgets` 3.0.17 (ipywidgets 8 widget manager) as a catalog dependency. It is injected only when the deployment does not provide one.
