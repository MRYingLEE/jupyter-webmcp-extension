/**
 * The per-component decision of the injection, from the static configuration.
 *
 * The runtime confirms this after the application starts (see the runtime
 * package), because a source-built extension may be absent from the list.
 */

import {
  AI_COMMANDS_PACKAGE,
  IPageConfig,
  RUNTIME_CONFIG_KEY,
  RUNTIME_EXTENSION,
  RUNTIME_PACKAGE,
  WEBMCP_PACKAGE,
  isExtensionDisabled,
  nativeExtensionNames
} from './config';

/**
 * What happens to one component:
 * - `injected`: the runtime provides it;
 * - `native`: the page already loads the package;
 * - `disabled`: the configuration disables the package.
 */
export type ComponentState = 'injected' | 'native' | 'disabled';

/** The decision for each component. */
export interface IInjectionDecision {
  ai: ComponentState;
  webmcp: ComponentState;
}

/**
 * Decide, from the static configuration, what the runtime provides.
 *
 * `disabledExtensions` wins over the native list: JupyterLab does not load a
 * disabled extension, so the page has nothing to defer to.
 */
export function decideInjection(config: IPageConfig): IInjectionDecision {
  const native = nativeExtensionNames(config);
  return {
    ai: componentState(config, native, AI_COMMANDS_PACKAGE),
    webmcp: componentState(config, native, WEBMCP_PACKAGE)
  };
}

/**
 * Whether the runtime has any component to provide.
 */
export function needsRuntime(decision: IInjectionDecision): boolean {
  return decision.ai === 'injected' || decision.webmcp === 'injected';
}

/**
 * Add the runtime to the configuration, with the decision the runtime reads.
 *
 * Returns the configuration unchanged when nothing is injected, or when the
 * runtime is already listed (for example after a second read).
 */
export function injectRuntime(
  config: IPageConfig,
  decision: IInjectionDecision,
  load: string
): IPageConfig {
  if (!needsRuntime(decision)) {
    return config;
  }
  const listed = config.federated_extensions.some(
    entry => entry?.name === RUNTIME_PACKAGE
  );
  if (listed) {
    return config;
  }
  return {
    ...config,
    federated_extensions: [
      ...config.federated_extensions,
      { name: RUNTIME_PACKAGE, load, extension: RUNTIME_EXTENSION }
    ],
    [RUNTIME_CONFIG_KEY]: {
      ai: decision.ai === 'injected',
      webmcp: decision.webmcp === 'injected'
    }
  };
}

function componentState(
  config: IPageConfig,
  native: Set<string>,
  name: string
): ComponentState {
  if (isExtensionDisabled(config, name)) {
    return 'disabled';
  }
  return native.has(name) ? 'native' : 'injected';
}
