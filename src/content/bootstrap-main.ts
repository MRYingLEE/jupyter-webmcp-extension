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
  parsePageConfig,
  RUNTIME_PACKAGE
} from '../shared/config';
import {
  RUNTIME_BASE_ATTRIBUTE,
  STATUS_EVENT
} from '../../runtime/src/channel';
import { decideInjection, injectRuntime, needsRuntime } from '../shared/decision';
import { allowsTools, mayInjectRuntime } from '../shared/frame-policy';

/** The state the hook keeps for one page. */
interface IHookState {
  lastText?: string;
  lastResult?: string;
  entryUrl?: string;
  entryLoad?: string;
  /** The absolute URL the page was asked to load the runtime from. */
  requestedSrc?: string;
  /** Whether the request was mapped to the extension's copy. */
  granted?: boolean;
}

/** What the hook needs to know about the frame it runs in. */
interface IHookEnv {
  load: string;
  toolsAllowed: boolean;
  report: (detail: string) => void;
}

/**
 * Install the hook on a window.
 *
 * `load` is the path of the runtime's remote entry relative to its package
 * directory, for example `static/remoteEntry.<hash>.js`.
 */
export function installPageHook(target: Window, load: string): void {
  const state: IHookState = {};
  const doc = target.document;
  const views = target as unknown as {
    Node: typeof Node;
    HTMLScriptElement: typeof HTMLScriptElement;
    Element: typeof Element;
  };
  const env: IHookEnv = {
    load,
    toolsAllowed: mayInjectRuntime({
      isTop: target.top === target,
      allowsTools: allowsTools(doc)
    }),
    report: detail => reportRuntimeFailure(doc, detail)
  };

  // A failed load of the runtime entry, from the extension or from the server,
  // is reported so the popup and badge show it.
  target.addEventListener(
    'error',
    event => {
      const element = event.target;
      if (
        !(element instanceof views.HTMLScriptElement) ||
        state.requestedSrc === undefined ||
        element.src !== state.requestedSrc
      ) {
        return;
      }
      env.report(
        state.granted
          ? 'Runtime script failed to load.'
          : 'Runtime is not enabled for this frame.'
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
 * Return the configuration text with the runtime added, when it is needed.
 */
function rewriteConfigText(text: string, env: IHookEnv, state: IHookState): string {
  if (state.lastText === text && state.lastResult !== undefined) {
    return state.lastResult;
  }
  let result = text;
  const config = parsePageConfig(text);
  if (config) {
    const decision = decideInjection(config);
    if (needsRuntime(decision)) {
      if (env.toolsAllowed) {
        const injected = injectRuntime(config, decision, env.load);
        result = JSON.stringify(injected);
        state.entryUrl = federatedEntryUrl(config, RUNTIME_PACKAGE, env.load);
        state.entryLoad = env.load;
      } else {
        env.report('The embedding frame does not allow the tools permission.');
      }
    }
  }
  state.lastText = text;
  state.lastResult = result;
  return result;
}

/**
 * Map the runtime entry URL to the extension copy, and leave other URLs alone.
 *
 * The extension base is read from the document attribute set by the isolated
 * bridge, because the MAIN world cannot call the extension APIs. Without the
 * base, the entry is left unmapped and its load fails, which is reported.
 */
function mapScriptUrl(value: string, doc: Document, state: IHookState): string {
  if (!state.entryUrl) {
    return value;
  }
  const resolved = new URL(value, doc.baseURI).href;
  const entry = new URL(state.entryUrl, doc.baseURI).href;
  if (resolved !== entry) {
    return value;
  }
  const base = doc.documentElement?.getAttribute(RUNTIME_BASE_ATTRIBUTE);
  state.granted = Boolean(base);
  const mapped = base ? `${base}${state.entryLoad}` : value;
  state.requestedSrc = new URL(mapped, doc.baseURI).href;
  return mapped;
}

/** Report that the runtime could not be provided to this frame. */
function reportRuntimeFailure(doc: Document, detail: string): void {
  doc.dispatchEvent(
    new CustomEvent(STATUS_EVENT, {
      detail: JSON.stringify({ component: 'runtime', state: 'failed', detail })
    })
  );
}
