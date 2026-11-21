/**
 * Constants and pure helpers for the Jupyter page configuration.
 *
 * Nothing here touches the browser APIs, so it is shared by the page bootstrap
 * (MAIN world), the isolated bridge, and the unit tests.
 */

/** The id of the `<script>` element holding the page configuration. */
export const CONFIG_ELEMENT_ID = 'jupyter-config-data';

/** The package name of the injected JupyterLab federated extension. */
export const RUNTIME_PACKAGE = '@jupyter-webmcp-extension/runtime';

/** The module exposing the plugins of the injected extension. */
export const RUNTIME_EXTENSION = './extension';

/** The package name of the AI commands extension. */
export const AI_COMMANDS_PACKAGE = 'jupyterlab-ai-commands';

/** The package name of the WebMCP extension. */
export const WEBMCP_PACKAGE = 'jupyter-webmcp';

/** The configuration key carrying the injection decision to the runtime. */
export { RUNTIME_CONFIG_KEY } from '../../runtime/src/channel';

/** The fields of a `federated_extensions` entry used here. */
export interface IFederatedExtension {
  name: string;
  load?: string;
  extension?: string;
  mimeExtension?: string;
  style?: string;
}

/** The subset of the page configuration that identifies a Jupyter page. */
export interface IPageConfig {
  federated_extensions: IFederatedExtension[];
  fullLabextensionsUrl: string;
  baseUrl?: string;
  appName?: string;
  appVersion?: string;
  disabledExtensions?: unknown;
  [key: string]: unknown;
}

/**
 * Parse the text of the configuration element.
 *
 * Returns `null` unless the text is a JSON object describing a Jupyter page:
 * it needs a `federated_extensions` array, a `fullLabextensionsUrl`, and an
 * application name or version.
 */
export function parsePageConfig(text: string): IPageConfig | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data)) {
    return null;
  }
  const { federated_extensions, fullLabextensionsUrl, appName, appVersion } =
    data;
  if (!Array.isArray(federated_extensions)) {
    return null;
  }
  if (typeof fullLabextensionsUrl !== 'string' || !fullLabextensionsUrl) {
    return null;
  }
  if (typeof appName !== 'string' && typeof appVersion !== 'string') {
    return null;
  }
  return data as IPageConfig;
}

/**
 * The URL that JupyterLab's bootstrap loads for a federated extension.
 */
export function federatedEntryUrl(
  config: Pick<IPageConfig, 'fullLabextensionsUrl'>,
  name: string,
  load: string
): string {
  const base = config.fullLabextensionsUrl.replace(/\/+$/, '');
  return `${base}/${name}/${load}`;
}

/**
 * Whether JupyterLab's configuration disables a plugin or its extension.
 *
 * JupyterLab checks both the plugin id and the extension name. Also accept
 * the map form used by some configuration sources.
 */
export function isExtensionDisabled(
  config: Pick<IPageConfig, 'disabledExtensions'>,
  id: string
): boolean {
  let disabled = config.disabledExtensions;
  if (typeof disabled === 'string') {
    try {
      disabled = JSON.parse(disabled);
    } catch {
      return false;
    }
  }
  const name = id.split(':', 1)[0];
  if (Array.isArray(disabled)) {
    return disabled.includes(id) || disabled.includes(name);
  }
  if (isRecord(disabled)) {
    return disabled[id] === true || disabled[name] === true;
  }
  return false;
}

/**
 * The names of the federated extensions the page already loads.
 */
export function nativeExtensionNames(config: IPageConfig): Set<string> {
  return new Set(
    config.federated_extensions
      .map(entry => entry?.name)
      .filter((name): name is string => typeof name === 'string')
  );
}

/**
 * Whether a value is a plain object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
