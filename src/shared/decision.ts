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
import {
  CATALOG,
  CatalogBuilds,
  ICatalogEntry,
  catalogEntry
} from './catalog';

/**
 * What happens to one component:
 * - `injected`: the runtime provides it;
 * - `native`: the page already loads the package;
 * - `disabled`: the configuration disables the package.
 */
export type ComponentState = 'injected' | 'native' | 'disabled';

/**
 * What happens to one catalog entry:
 * - `injected`: the runtime loads the bundled build;
 * - `native`: the page already loads the federated package;
 * - `disabled`: the configuration disables the plugin;
 * - `conflict`: a native package with the same API is already loaded;
 * - `unsupported`: a dependency is disabled, so the entry cannot run;
 * - `unselected`: the user did not select the entry.
 */
export type CatalogState =
  | 'injected'
  | 'native'
  | 'disabled'
  | 'conflict'
  | 'unsupported'
  | 'unselected';

/** The decision for each component and catalog entry. */
export interface IInjectionDecision {
  ai: ComponentState;
  webmcp: ComponentState;
  catalog: Record<string, CatalogState>;
}

/** One file the runtime injects, and the component that reports on it. */
export interface IInjectedEntry {
  /** The status component: `runtime` or a catalog id. */
  component: string;
  /** The federated extension name, as JupyterLab loads it. */
  name: string;
  /** The load path written into the page configuration. */
  load: string;
  /** The module exporting the plugins. */
  extension: string;
  /** The bundled file, relative to the runtime base URL. */
  path: string;
}

/**
 * Decide, from the static configuration and the user's selection, what the
 * runtime provides.
 *
 * `disabledExtensions` wins over the native list: JupyterLab does not load a
 * disabled extension, so the page has nothing to defer to.
 */
export function decideInjection(
  config: IPageConfig,
  selected: ReadonlySet<string> = new Set()
): IInjectionDecision {
  const native = nativeExtensionNames(config);
  return {
    ai: componentState(config, native, AI_COMMANDS_PACKAGE),
    webmcp: componentState(config, native, WEBMCP_PACKAGE),
    catalog: decideCatalog(config, selected)
  };
}

/**
 * Decide the state of each catalog entry.
 *
 * A dependency is injected only when a selected extension that will be
 * injected requires it. An extension whose dependency is disabled is
 * `unsupported`, not injected.
 */
export function decideCatalog(
  config: IPageConfig,
  selected: ReadonlySet<string>
): Record<string, CatalogState> {
  const native = nativeExtensionNames(config);
  const states: Record<string, CatalogState> = {};
  const candidates: ICatalogEntry[] = [];

  for (const entry of CATALOG) {
    if (entry.role !== 'extension') {
      continue;
    }
    if (!selected.has(entry.id)) {
      states[entry.id] = 'unselected';
    } else if (isExtensionDisabled(config, entry.plugin)) {
      states[entry.id] = 'disabled';
    } else if (native.has(entry.federation)) {
      states[entry.id] = 'native';
    } else if (entry.conflicts?.some(name => native.has(name))) {
      states[entry.id] = 'conflict';
    } else {
      candidates.push(entry);
      states[entry.id] = 'injected';
    }
  }

  const needed = new Set(candidates.flatMap(entry => entry.requires));
  for (const entry of CATALOG) {
    if (entry.role !== 'dependency') {
      continue;
    }
    if (isExtensionDisabled(config, entry.plugin)) {
      states[entry.id] = 'disabled';
    } else if (native.has(entry.federation)) {
      states[entry.id] = 'native';
    } else {
      states[entry.id] = needed.has(entry.id) ? 'injected' : 'unselected';
    }
  }

  for (const entry of candidates) {
    const blocked = entry.requires.some(id => states[id] === 'disabled');
    if (blocked) {
      states[entry.id] = 'unsupported';
    }
  }

  return states;
}

/**
 * Whether the runtime has any component to provide.
 */
export function needsRuntime(decision: IInjectionDecision): boolean {
  return (
    decision.ai === 'injected' ||
    decision.webmcp === 'injected' ||
    Object.values(decision.catalog).includes('injected')
  );
}

/**
 * The files the page hook redirects to the extension, in load order.
 *
 * Empty when nothing is injected. A catalog entry without a build is skipped;
 * the build step always provides every entry in the pins.
 */
export function injectedEntries(
  decision: IInjectionDecision,
  runtimeLoad: string,
  builds: CatalogBuilds
): IInjectedEntry[] {
  if (!needsRuntime(decision)) {
    return [];
  }
  const runtime: IInjectedEntry = {
    component: 'runtime',
    name: RUNTIME_PACKAGE,
    load: runtimeLoad,
    extension: RUNTIME_EXTENSION,
    path: runtimeLoad
  };
  const catalog: IInjectedEntry[] = [];
  for (const entry of CATALOG) {
    const build = builds[entry.id];
    if (decision.catalog[entry.id] !== 'injected' || !build) {
      continue;
    }
    catalog.push({
      component: entry.id,
      name: entry.federation,
      load: build.load,
      extension: build.extension,
      path: `catalog/${entry.id}/${build.load}`
    });
  }
  return [runtime, ...catalog];
}

/**
 * Add the runtime and the injected catalog entries to the configuration, with
 * the decision the runtime reads.
 *
 * Returns the configuration unchanged when nothing is injected, or when the
 * runtime is already listed (for example after a second read).
 */
export function injectRuntime(
  config: IPageConfig,
  decision: IInjectionDecision,
  runtimeLoad: string,
  builds: CatalogBuilds
): IPageConfig {
  const entries = injectedEntries(decision, runtimeLoad, builds);
  if (entries.length === 0) {
    return config;
  }
  const listed = config.federated_extensions.some(
    entry => entry?.name === RUNTIME_PACKAGE
  );
  if (listed) {
    return config;
  }
  const catalog = entries
    .filter(entry => entry.component !== 'runtime')
    .map(entry => ({
      id: entry.component,
      plugin: catalogEntry(entry.component)?.plugin ?? ''
    }))
    .filter(flag => flag.plugin !== '');
  return {
    ...config,
    federated_extensions: [
      ...config.federated_extensions,
      ...entries.map(({ name, load, extension }) => ({
        name,
        load,
        extension
      }))
    ],
    [RUNTIME_CONFIG_KEY]: {
      ai: decision.ai === 'injected',
      webmcp: decision.webmcp === 'injected',
      catalog
    }
  };
}

function componentState(
  config: IPageConfig,
  native: Set<string>,
  name: string
): ComponentState {
  if (isExtensionDisabled(config, `${name}:plugin`)) {
    return 'disabled';
  }
  return native.has(name) ? 'native' : 'injected';
}
