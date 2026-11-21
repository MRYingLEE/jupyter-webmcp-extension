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
import { IRuntimeArtifact } from './runtime-catalog';

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
  /** The status component: `runtime`, a catalog id, or a package id. */
  component: string;
  /** The federated extension name, as JupyterLab loads it. */
  name: string;
  /** The load path written into the page configuration. */
  load: string;
  /** The module exporting the plugins. */
  extension: string;
  /** The bundled file, relative to the runtime base URL. Absent for a package, which is served from its verified files. */
  path?: string;
}

/** A verified package the page injects as a federated extension. */
export interface IPackageEntry {
  /** The package's catalog id, `pypi:<name>`. */
  id: string;
  /** The federated extension name. */
  name: string;
  load: string;
  extension: string;
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
 * The verified packages the page injects: selected, not loaded by the page
 * already, not disabled by the configuration, and not named like a pinned
 * entry, which the page provides from its bundle. The first package of each
 * federation name wins.
 */
export function packageEntries(
  config: IPageConfig,
  selected: ReadonlySet<string>,
  artifacts: Record<string, IRuntimeArtifact>
): IPackageEntry[] {
  const native = nativeExtensionNames(config);
  const pinned = new Set(CATALOG.map(entry => entry.federation));
  const taken = new Set<string>();
  const entries: IPackageEntry[] = [];
  for (const [id, artifact] of Object.entries(artifacts)) {
    const name = artifact.federation;
    if (
      !selected.has(id) ||
      native.has(name) ||
      pinned.has(name) ||
      taken.has(name) ||
      isExtensionDisabled(config, name)
    ) {
      continue;
    }
    taken.add(name);
    entries.push({ id, name, load: artifact.load, extension: artifact.extension });
  }
  return entries;
}

/**
 * The files the page hook redirects to the extension, in load order: the
 * runtime when it is needed, the injected catalog entries, then the packages.
 *
 * A catalog entry without a build is skipped; the build step always provides
 * every entry in the pins.
 */
export function injectedEntries(
  decision: IInjectionDecision,
  runtimeLoad: string,
  builds: CatalogBuilds,
  packages: readonly IPackageEntry[]
): IInjectedEntry[] {
  const entries: IInjectedEntry[] = [];
  if (needsRuntime(decision)) {
    entries.push({
      component: 'runtime',
      name: RUNTIME_PACKAGE,
      load: runtimeLoad,
      extension: RUNTIME_EXTENSION,
      path: runtimeLoad
    });
  }
  for (const entry of CATALOG) {
    const build = builds[entry.id];
    if (decision.catalog[entry.id] !== 'injected' || !build) {
      continue;
    }
    entries.push({
      component: entry.id,
      name: entry.federation,
      load: build.load,
      extension: build.extension,
      path: `catalog/${entry.id}/${build.load}`
    });
  }
  for (const pkg of packages) {
    entries.push({
      component: pkg.id,
      name: pkg.name,
      load: pkg.load,
      extension: pkg.extension
    });
  }
  return entries;
}

/**
 * Add the runtime, the injected catalog entries, and the packages to the
 * configuration, with the decision the runtime reads.
 *
 * Returns the configuration unchanged when nothing is injected, or when the
 * runtime is already listed (for example after a second read).
 */
export function injectRuntime(
  config: IPageConfig,
  decision: IInjectionDecision,
  runtimeLoad: string,
  builds: CatalogBuilds,
  packages: readonly IPackageEntry[]
): IPageConfig {
  const entries = injectedEntries(decision, runtimeLoad, builds, packages);
  if (entries.length === 0) {
    return config;
  }
  const listed = config.federated_extensions.some(
    entry => entry?.name === RUNTIME_PACKAGE
  );
  if (listed) {
    return config;
  }
  const federated = [
    ...config.federated_extensions,
    ...entries.map(({ name, load, extension }) => ({ name, load, extension }))
  ];
  if (!needsRuntime(decision)) {
    return { ...config, federated_extensions: federated };
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
    federated_extensions: federated,
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
