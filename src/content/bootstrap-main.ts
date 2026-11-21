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
  RUNTIME_BASE_ATTRIBUTE,
  STATUS_EVENT
} from '../../runtime/src/channel';
import { CatalogBuilds } from '../shared/catalog';
import {
  decideInjection,
  injectRuntime,
  injectedEntries,
  needsRuntime
} from '../shared/decision';
import { allowsTools, mayInjectRuntime } from '../shared/frame-policy';
import { SELECTION_KEY, selectionFor } from '../shared/selection';

/** A federated entry the hook maps to the extension's bundled copy. */
interface IMappedEntry {
  /** The status component reporting on this entry. */
  component: string;
  /** The absolute URL JupyterLab is expected to load. */
  url: string;
  /** The bundled file, relative to the runtime base URL. */
  path: string;
  /** The absolute URL the page was asked to load after mapping. */
  requested?: string;
  /** Whether the request was mapped to the extension's copy. */
  granted?: boolean;
}

/** The state the hook keeps for one page. */
interface IHookState {
  lastText?: string;
  lastSelection?: string | null;
  lastResult?: string;
  entries: IMappedEntry[];
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
  const state: IHookState = { entries: [] };
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
 * The selection is read on every call, because the popup may change it
 * between reads; an unchanged text and selection return the cached result.
 */
function rewriteConfigText(text: string, env: IHookEnv, state: IHookState): string {
  const raw = readSelection(env.target);
  if (
    state.lastText === text &&
    state.lastSelection === raw &&
    state.lastResult !== undefined
  ) {
    return state.lastResult;
  }
  let result = text;
  state.entries = [];
  const config = parsePageConfig(text);
  if (config) {
    const selected = selectionFor(raw, config.baseUrl);
    const decision = decideInjection(config, selected);
    if (needsRuntime(decision)) {
      if (env.toolsAllowed) {
        const injected = injectRuntime(config, decision, env.load, env.builds);
        result = JSON.stringify(injected);
        state.entries = injectedEntries(decision, env.load, env.builds).map(
          entry => ({
            component: entry.component,
            url: federatedEntryUrl(config, entry.name, entry.load),
            path: entry.path
          })
        );
      } else {
        env.report('runtime', 'The embedding frame does not allow the tools permission.');
      }
    }
  }
  state.lastText = text;
  state.lastSelection = raw;
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
 * Map an injected entry's URL to the extension copy, and leave other URLs alone.
 *
 * The extension base is read from the document attribute set by the isolated
 * bridge, because the MAIN world cannot call the extension APIs. Without the
 * base, the entry is left unmapped and its load fails, which is reported.
 */
function mapScriptUrl(value: string, doc: Document, state: IHookState): string {
  const resolved = new URL(value, doc.baseURI).href;
  const entry = state.entries.find(
    candidate => new URL(candidate.url, doc.baseURI).href === resolved
  );
  if (!entry) {
    return value;
  }
  const base = doc.documentElement?.getAttribute(RUNTIME_BASE_ATTRIBUTE);
  entry.granted = Boolean(base);
  const mapped = base ? `${base}${entry.path}` : value;
  entry.requested = new URL(mapped, doc.baseURI).href;
  return mapped;
}

/** Report that a component could not be provided to this frame. */
function reportFailure(doc: Document, component: string, detail: string): void {
  doc.dispatchEvent(
    new CustomEvent(STATUS_EVENT, {
      detail: JSON.stringify({ component, state: 'failed', detail })
    })
  );
}
