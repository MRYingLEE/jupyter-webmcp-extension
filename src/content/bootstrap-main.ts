/**
 * MAIN-world page hook, run at `document_start`.
 *
 * JupyterLab's bootstrap reads `#jupyter-config-data` and loads each
 * `federated_extensions` entry as a script. This hook adds the runtime entry
 * to the configuration at read time, and maps only that entry's URL to the
 * copy shipped with the extension. Other scripts are not touched.
 */

import {
  CONFIG_ELEMENT_ID,
  federatedEntryUrl,
  parsePageConfig
} from '../shared/config';
import {
  CATALOG_SOURCES_ATTRIBUTE,
  RUNTIME_ARTIFACTS_ATTRIBUTE,
  RUNTIME_BASE_ATTRIBUTE,
  STATUS_EVENT
} from '../../runtime/src/channel';
import { CatalogBuilds } from '../shared/catalog';
import {
  BLOCKED_KEY_PREFIX,
  ICatalogSource,
  IRuntimeArtifact,
  RUNTIME_CACHE_KEY,
  blobArtifacts,
  filePathOf,
  parseArtifacts,
  payloadsFrom,
  usableArtifacts
} from '../shared/runtime-catalog';
import {
  decideInjection,
  injectRuntime,
  injectedEntries,
  needsRuntime,
  packageEntries
} from '../shared/decision';
import { allowsTools, mayInjectRuntime } from '../shared/frame-policy';
import { SELECTION_KEY, selectionFor } from '../shared/selection';

/** A federated entry the hook maps to the extension's bundled copy or a verified blob. */
interface IMappedEntry {
  /** The status component reporting on this entry. */
  component: string;
  /** The absolute URL JupyterLab is expected to load. */
  url: string;
  /** The bundled file, relative to the runtime base URL. Absent for a package. */
  path?: string;
  /** The absolute URL the page was asked to load after mapping. */
  requested?: string;
  /** Whether the request was mapped to the extension's copy. */
  granted?: boolean;
  /** The verified build serving this entry, when one is used. */
  build?: IRuntimeBuild;
}

/** A verified runtime file served from a blob URL, with the catalog id and version it belongs to. */
interface IRuntimeBuild {
  url: string;
  component: string;
  version: string;
}

/** The state the hook keeps for one page. */
interface IHookState {
  lastText?: string;
  lastKey?: string;
  lastResult?: string;
  entries: IMappedEntry[];
  /** Verified chunk URLs by file name. Webpack requests chunks relative to the blob entry, so they are matched by name. */
  chunks: Map<string, string>;
  /** Verified files by URL, to find the build behind a load that failed. */
  owners: Map<string, IRuntimeBuild>;
  /** The cached payload text the artifact table was last built from, and that table. */
  cachedFrom?: string;
  cachedRaw?: string | null;
}

/** What the hook needs to know about the frame it runs in. */
interface IHookEnv {
  target: Window;
  load: string;
  builds: CatalogBuilds;
  toolsAllowed: boolean;
  report: (component: string, detail: string) => void;
}

/**
 * Install the hook on a window.
 *
 * `load` is the path of the runtime's remote entry relative to its package
 * directory, for example `static/remoteEntry.<hash>.js`. `builds` maps each
 * catalog id to its bundled load path and module.
 */
export function installPageHook(
  target: Window,
  load: string,
  builds: CatalogBuilds
): void {
  const state: IHookState = { entries: [], chunks: new Map(), owners: new Map() };
  const doc = target.document;
  const views = target as unknown as {
    Node: typeof Node;
    HTMLScriptElement: typeof HTMLScriptElement;
    Element: typeof Element;
  };
  const env: IHookEnv = {
    target,
    load,
    builds,
    toolsAllowed: mayInjectRuntime({
      isTop: target.top === target,
      allowsTools: allowsTools(doc)
    }),
    report: (component, detail) => reportFailure(doc, component, detail)
  };

  // A failed load of an injected entry, from the extension or from the
  // server, is reported under its component so the popup and badge show it.
  target.addEventListener(
    'error',
    event => {
      const element = event.target;
      if (!(element instanceof views.HTMLScriptElement)) {
        return;
      }
      const owner = state.owners.get(element.src);
      if (owner) {
        // A verified build that fails to load is blocked by the page's CSP. The
        // block is kept for this tab until the verified version changes.
        markBlocked(env.target, owner);
        env.report(
          owner.component,
          'Blocked by the page. The bundled build is used after reload.'
        );
        return;
      }
      const entry = state.entries.find(
        candidate => candidate.requested === element.src
      );
      if (!entry) {
        return;
      }
      env.report(
        entry.component,
        entry.granted
          ? 'Script failed to load.'
          : 'Not enabled for this frame.'
      );
    },
    true
  );

  // Chrome defines `textContent` on HTMLScriptElement.prototype itself, which
  // shadows the one on Node.prototype, so the hook wraps the script's own
  // descriptor and falls back to Node's where the script's is absent.
  const scriptProto = views.HTMLScriptElement.prototype;
  const textDesc =
    Object.getOwnPropertyDescriptor(scriptProto, 'textContent') ??
    Object.getOwnPropertyDescriptor(views.Node.prototype, 'textContent');
  if (!textDesc?.get) {
    return;
  }
  const originalGet = textDesc.get;
  Object.defineProperty(scriptProto, 'textContent', {
    ...textDesc,
    get(this: Node): string | null {
      const text = originalGet.call(this) as string | null;
      if (
        text === null ||
        !(this instanceof views.HTMLScriptElement) ||
        this.id !== CONFIG_ELEMENT_ID
      ) {
        return text;
      }
      return rewriteConfigText(text, env, state);
    }
  });

  const srcDesc = Object.getOwnPropertyDescriptor(views.HTMLScriptElement.prototype, 'src');
  if (srcDesc?.set) {
    const originalSet = srcDesc.set;
    Object.defineProperty(views.HTMLScriptElement.prototype, 'src', {
      ...srcDesc,
      set(this: HTMLScriptElement, value: string) {
        originalSet.call(this, mapScriptUrl(String(value), doc, state));
      }
    });
  }

  const originalSetAttribute = views.Element.prototype.setAttribute;
  views.Element.prototype.setAttribute = function (
    this: Element,
    name: string,
    value: string
  ): void {
    if (this instanceof views.HTMLScriptElement && name.toLowerCase() === 'src') {
      value = mapScriptUrl(String(value), doc, state);
    }
    originalSetAttribute.call(this, name, value);
  };
}

/**
 * Return the configuration text with the runtime and the selected catalog
 * entries added, when any is needed.
 *
 * The selection, the runtime artifacts, and the blocked records are read on
 * every call, because each may change between reads; unchanged inputs return
 * the cached result.
 */
function rewriteConfigText(text: string, env: IHookEnv, state: IHookState): string {
  const raw = readSelection(env.target);
  const root = env.target.document.documentElement;
  const artifactsRaw =
    root?.getAttribute(RUNTIME_ARTIFACTS_ATTRIBUTE) ?? cachedArtifactsRaw(env.target, state);
  const blocked = readBlocked(env.target);
  const key = JSON.stringify([raw, artifactsRaw, blocked]);
  if (state.lastText === text && state.lastKey === key && state.lastResult !== undefined) {
    return state.lastResult;
  }
  let result = text;
  state.entries = [];
  state.chunks = new Map();
  state.owners = new Map();
  const artifacts = parseArtifacts(artifactsRaw);
  const usable = usableArtifacts(artifacts, blocked);
  const sources: Record<string, ICatalogSource> = {};
  const config = parsePageConfig(text);
  if (config) {
    const selected = selectionFor(raw, config.baseUrl, Object.keys(usable));
    const decision = decideInjection(config, selected);
    const packages = packageEntries(config, selected, usable);
    if (needsRuntime(decision) || packages.length > 0) {
      if (env.toolsAllowed) {
        const injected = injectRuntime(config, decision, env.load, env.builds, packages);
        result = JSON.stringify(injected);
        const entries = injectedEntries(decision, env.load, env.builds, packages);
        state.entries = entries.map(entry => ({
          component: entry.component,
          url: federatedEntryUrl(config, entry.name, entry.load),
          path: entry.path,
          build: runtimeBuildOf(usable, entry.component)
        }));
        for (const entry of entries) {
          if (entry.component === 'runtime') {
            continue;
          }
          sources[entry.component] = sourceOf(entry.component, artifacts, usable, blocked);
          const artifact = usable[entry.component];
          if (artifact) {
            indexRuntimeFiles(entry.component, artifact, state);
          }
        }
      } else {
        env.report('runtime', 'The embedding frame does not allow the tools permission.');
      }
    }
  }
  root?.setAttribute(CATALOG_SOURCES_ATTRIBUTE, JSON.stringify(sources));
  state.lastText = text;
  state.lastKey = key;
  state.lastResult = result;
  return result;
}

/**
 * The raw selection record, or `null` when the frame cannot read its storage.
 */
function readSelection(target: Window): string | null {
  try {
    return target.sessionStorage.getItem(SELECTION_KEY);
  } catch {
    return null;
  }
}

/**
 * The artifact table built from the origin's cached payloads, for a read before
 * the bridge has replied. Null when nothing usable is cached.
 */
function cachedArtifactsRaw(target: Window, state: IHookState): string | null {
  let stored: string | null;
  try {
    stored = target.localStorage.getItem(RUNTIME_CACHE_KEY);
  } catch {
    return null;
  }
  if (stored === null) {
    return null;
  }
  if (state.cachedFrom !== stored) {
    state.cachedFrom = stored;
    state.cachedRaw = null;
    try {
      const payloads = payloadsFrom(JSON.parse(stored));
      state.cachedRaw = JSON.stringify(blobArtifacts(payloads));
    } catch {
      // A cache that is not valid JSON or base64 is ignored, as if absent.
    }
  }
  return state.cachedRaw ?? null;
}

/**
 * Map an injected entry's URL to the copy it should load, and leave other URLs alone.
 *
 * An entry with a verified build loads that build's blob. Otherwise it maps to
 * the bundled copy under the extension base, which the isolated bridge sets on
 * the document because the MAIN world cannot call the extension APIs. Without
 * the base, the entry is left unmapped and its load fails, which is reported.
 *
 * A chunk of a verified build is matched by file name, because webpack derives
 * chunk URLs from the entry's blob URL rather than from the verified files.
 */
function mapScriptUrl(value: string, doc: Document, state: IHookState): string {
  const resolved = new URL(value, doc.baseURI).href;
  const entry = state.entries.find(
    candidate => new URL(candidate.url, doc.baseURI).href === resolved
  );
  if (!entry) {
    const chunk = state.chunks.get(new URL(resolved).pathname.split('/').pop() ?? '');
    return chunk ?? value;
  }
  let mapped: string;
  if (entry.build) {
    mapped = entry.build.url;
    entry.granted = true;
  } else {
    const base = doc.documentElement?.getAttribute(RUNTIME_BASE_ATTRIBUTE);
    entry.granted = Boolean(base && entry.path);
    mapped = base && entry.path ? `${base}${entry.path}` : value;
  }
  entry.requested = new URL(mapped, doc.baseURI).href;
  return mapped;
}

/** Read the verified versions the page blocked earlier in this tab, by component. */
function readBlocked(target: Window): Record<string, string> {
  const blocked: Record<string, string> = {};
  try {
    for (let index = 0; index < target.sessionStorage.length; index++) {
      const key = target.sessionStorage.key(index);
      if (key === null || !key.startsWith(BLOCKED_KEY_PREFIX)) {
        continue;
      }
      const version = target.sessionStorage.getItem(key);
      if (version !== null) {
        blocked[key.slice(BLOCKED_KEY_PREFIX.length)] = version;
      }
    }
  } catch {
    // Without storage, no block is known.
  }
  return blocked;
}

/**
 * Record that the page blocked a verified build, so later reads use the
 * bundled build until the verified version changes.
 */
function markBlocked(target: Window, build: IRuntimeBuild): void {
  try {
    target.sessionStorage.setItem(BLOCKED_KEY_PREFIX + build.component, build.version);
  } catch {
    // Without storage, the next load tries the verified build again.
  }
}

/** The verified build serving a catalog entry, or `undefined` when none is usable. */
function runtimeBuildOf(
  usable: Record<string, IRuntimeArtifact>,
  id: string
): IRuntimeBuild | undefined {
  const artifact = usable[id];
  if (!artifact) {
    return undefined;
  }
  return {
    url: artifact.urls[filePathOf(artifact.load)],
    component: id,
    version: artifact.version
  };
}

/** Index a verified build's files: by URL for block reports, and its chunks by file name. */
function indexRuntimeFiles(id: string, artifact: IRuntimeArtifact, state: IHookState): void {
  for (const [path, url] of Object.entries(artifact.urls)) {
    state.owners.set(url, { url, component: id, version: artifact.version });
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (path.endsWith('.js') && !state.chunks.has(name)) {
      state.chunks.set(name, url);
    }
  }
}

/** How a catalog entry is provided to the page: a usable verified build, a blocked one, or the bundled one. */
function sourceOf(
  id: string,
  artifacts: Record<string, IRuntimeArtifact>,
  usable: Record<string, IRuntimeArtifact>,
  blocked: Record<string, string>
): ICatalogSource {
  const served = usable[id];
  if (served) {
    return { source: 'runtime', version: served.version };
  }
  const artifact = artifacts[id];
  if (artifact && blocked[id] === artifact.version) {
    return { source: 'blocked', version: artifact.version };
  }
  return { source: 'bundled' };
}

/** Report that a component could not be provided to this frame. */
function reportFailure(doc: Document, component: string, detail: string): void {
  doc.dispatchEvent(
    new CustomEvent(STATUS_EVENT, {
      detail: JSON.stringify({ component, state: 'failed', detail })
    })
  );
}
