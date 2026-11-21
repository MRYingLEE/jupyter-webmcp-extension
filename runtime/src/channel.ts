/**
 * The protocol between the browser extension and the injected runtime.
 *
 * The MAIN-world code and the runtime cannot call extension APIs, so the
 * isolated bridge answers the DOM events below. This file has no imports, so
 * the bridge and the page code can both use it.
 */

/** The page configuration key with the components the runtime provides. */
export const RUNTIME_CONFIG_KEY = 'jupyterWebmcpRuntime';

/** A catalog extension the page hook injected, with the plugin the runtime checks. */
export interface ICatalogFlag {
  id: string;
  plugin: string;
}

/** The components the page hook decided to provide, read by the runtime. */
export interface IRuntimeFlags {
  ai: boolean;
  webmcp: boolean;
  catalog: ICatalogFlag[];
}

/** The attribute of `<html>` holding the extension's runtime base URL. */
export const RUNTIME_BASE_ATTRIBUTE = 'data-jwe-runtime-base';

/** The attribute of `<html>` holding the verified runtime artifacts, as JSON. */
export const RUNTIME_ARTIFACTS_ATTRIBUTE = 'data-jwe-runtime-artifacts';

/** The attribute of `<html>` holding each catalog id's source (runtime, bundled, or blocked), as JSON. */
export const CATALOG_SOURCES_ATTRIBUTE = 'data-jwe-catalog-sources';

/** Dispatched by the runtime to ask for the settings; `detail` is `{nonce}` JSON. */
export const SETTINGS_REQUEST = 'jupyter-webmcp-extension:settings-request';

/** Dispatched by the bridge with `{nonce, settings}` JSON as the answer. */
export const SETTINGS_RESPONSE = 'jupyter-webmcp-extension:settings-response';

/** Dispatched by the bridge with `{settings}` JSON when the settings change. */
export const SETTINGS_CHANGED = 'jupyter-webmcp-extension:settings-changed';

/** Dispatched by the runtime with a `{component, state, detail?}` JSON status. */
export const STATUS_EVENT = 'jupyter-webmcp-extension:status';

/**
 * The components the runtime can provide: `ai`, `webmcp`, `runtime` (the loading
 * of the runtime itself, reported by the page hook when it cannot be loaded),
 * or the id of an injected catalog extension.
 */
export type RuntimeComponent = string;

/** The outcome of a component in the runtime. */
export type RuntimeState = 'active' | 'failed';

/** A status report from the runtime. */
export interface IRuntimeStatus {
  component: RuntimeComponent;
  state: RuntimeState;
  detail?: string;
}
