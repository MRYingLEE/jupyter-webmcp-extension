/**
 * Toolbar popup: shows the current site, its enablement, and the tab status,
 * and lets the user enable or disable the extension for the site.
 */

import type { IEmbeddedStatus, IStateResponse, ITabStatus } from '../shared/messages';
import { originPattern, webOrigin } from '../shared/origin';
import { CATALOG, catalogEntry } from '../shared/catalog';
import { CatalogState, decideInjection } from '../shared/decision';
import { parsePageConfig } from '../shared/config';
import { SELECTION_KEY, selectionFor, serializeSelection } from '../shared/selection';
import { CATALOG_SOURCES_ATTRIBUTE } from '../../runtime/src/channel';
import type { ICatalogSource } from '../shared/runtime-catalog';
import type { IRuntimeCatalogState, IRuntimePackageState } from '../shared/messages';

const originLabel = document.getElementById('origin') as HTMLElement;
const message = document.getElementById('message') as HTMLElement;
const toggle = document.getElementById('toggle') as HTMLButtonElement;
const reload = document.getElementById('reload') as HTMLButtonElement;
const statusList = document.getElementById('status') as HTMLElement;
const catalogSection = document.getElementById('catalog') as HTMLElement;
const catalogList = document.getElementById('catalog-list') as HTMLElement;
const catalogNote = document.getElementById('catalog-note') as HTMLElement;
const applyCatalog = document.getElementById('apply-catalog') as HTMLButtonElement;

const COMPONENT_LABELS: Partial<Record<string, string>> = {
  ai: 'AI commands',
  webmcp: 'WebMCP',
  runtime: 'Runtime'
};

const CATALOG_STATE_LABELS: Record<CatalogState, string> = {
  injected: 'will be injected',
  native: 'already loaded by this page',
  disabled: 'disabled in this Jupyter instance',
  conflict: 'a native extension with the same API is already loaded',
  unsupported: 'a required dependency is disabled',
  unselected: 'not selected'
};

let tabId: number | undefined;
let origin: string | null = null;
/** The base URL of the Jupyter instance on this tab, when the catalog is shown. */
let catalogBaseUrl: string | null = null;

/** The result of reading the page's configuration and selection. */
interface IPageSnapshot {
  configText: string | null;
  selection: string | null;
  /** The JSON record of how each catalog entry is provided, as the page hook reports it. */
  sources: string | null;
}

function componentLabel(component: string): string {
  return COMPONENT_LABELS[component] ?? catalogEntry(component)?.label ?? component;
}

function showMessage(text: string, error = false): void {
  message.textContent = text;
  message.className = error ? 'message error' : 'message';
  message.hidden = false;
}

function appendComponents(
  prefix: string,
  status: ITabStatus | undefined
): number {
  let shown = 0;
  for (const [component, info] of Object.entries(status?.components ?? {})) {
    if (!info) {
      continue;
    }
    const item = document.createElement('li');
    item.className = `state-${info.state}`;
    const label = componentLabel(component);
    const heading = document.createElement('span');
    heading.textContent = `${prefix}${label}: ${info.state}`;
    item.append(heading);
    if (info.detail) {
      const detail = document.createElement('div');
      detail.className = 'status-detail';
      detail.textContent = info.detail;
      item.append(detail);
    }
    statusList.append(item);
    shown += 1;
  }
  return shown;
}

function renderStatus(status: ITabStatus | undefined, embedded: IEmbeddedStatus[]): void {
  statusList.replaceChildren();
  const shown = appendComponents('', status);
  for (const frame of embedded) {
    appendComponents(`Embedded ${frame.origin}: `, frame);
  }
  if (shown === 0 && embedded.length === 0) {
    const item = document.createElement('li');
    item.className = 'muted';
    item.textContent = 'No runtime status for this page yet.';
    statusList.append(item);
  }
}

function renderEnabled(enabled: boolean): void {
  toggle.hidden = false;
  toggle.textContent = enabled ? 'Disable on this site' : 'Enable on this site';
  toggle.dataset.enabled = String(enabled);
}

async function refresh(): Promise<void> {
  if (tabId === undefined || origin === null) {
    return;
  }
  const response = (await chrome.runtime.sendMessage({
    type: 'state',
    tabId,
    origin
  })) as IStateResponse;
  renderEnabled(response.enabled);
  renderStatus(response.status, response.embedded);
  await renderCatalog(tabId, response.enabled);
}

/** Read the page's configuration and selection from the top frame's main world. */
async function readPage(id: number): Promise<IPageSnapshot | null> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: id, frameIds: [0] },
      world: 'MAIN',
      args: [SELECTION_KEY, CATALOG_SOURCES_ATTRIBUTE],
      // `text` is read instead of `textContent`, which the page hook rewrites.
      func: (key: string, sourcesAttribute: string) => {
        const element = document.getElementById('jupyter-config-data') as HTMLScriptElement | null;
        let selection: string | null = null;
        try {
          selection = sessionStorage.getItem(key);
        } catch {
          selection = null;
        }
        return {
          configText: element ? element.text : null,
          selection,
          sources: document.documentElement.getAttribute(sourcesAttribute)
        };
      }
    });
    return (injection?.result as IPageSnapshot | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Store the selection record in the top frame's sessionStorage. */
async function writeSelection(id: number, value: string): Promise<boolean> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: id, frameIds: [0] },
      world: 'MAIN',
      args: [SELECTION_KEY, value],
      func: (key: string, data: string) => {
        try {
          sessionStorage.setItem(key, data);
          return true;
        } catch {
          return false;
        }
      }
    });
    return injection?.result === true;
  } catch {
    return false;
  }
}

/** Parse the page's catalog sources record. Unknown or malformed records yield none. */
function parseSources(text: string | null): Record<string, ICatalogSource> {
  if (!text) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ICatalogSource>) : {};
  } catch {
    return {};
  }
}

/** The loaded runtime packages. A failed read yields none. */
async function loadedPackages(): Promise<IRuntimePackageState[]> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'runtimeCatalogState'
    })) as { ok: boolean; state?: IRuntimeCatalogState };
    return response.ok && response.state ? response.state.packages : [];
  } catch {
    return [];
  }
}

/** Describe where the page gets an entry's code: the verified runtime, the bundled build, or nothing. */
function sourceDetail(id: string, sources: Record<string, ICatalogSource>): string | null {
  const source = sources[id];
  if (!source) {
    return null;
  }
  if (source.source === 'runtime') {
    return `Loaded from verified runtime${source.version ? ` ${source.version}` : ''}`;
  }
  if (source.source === 'blocked') {
    return 'Blocked by the page CSP; the bundled build is used for this tab';
  }
  return 'Bundled build';
}

/** The labels of a catalog entry's state and its kernel requirement, if any. */
function catalogDetails(id: string, state: CatalogState): string[] {
  const entry = catalogEntry(id);
  if (!entry) {
    return [];
  }
  const lines = [
    entry.role === 'dependency'
      ? `Dependency, ${CATALOG_STATE_LABELS[state]}`
      : CATALOG_STATE_LABELS[state]
  ];
  if (entry.role === 'dependency') {
    const required = CATALOG.filter(other => other.requires.includes(entry.id)).map(
      other => other.label
    );
    lines.push(`Required by ${required.join(', ')}`);
  }
  if (entry.kernelRequirement) {
    lines.push(`Kernel: pip install "${entry.kernelRequirement}"`);
  }
  return lines;
}

/** Show the catalog for an enabled tab whose page is a Jupyter instance. */
async function renderCatalog(id: number, enabled: boolean): Promise<void> {
  catalogSection.hidden = true;
  if (!enabled) {
    return;
  }
  const snapshot = await readPage(id);
  const config = snapshot?.configText ? parsePageConfig(snapshot.configText) : null;
  if (!snapshot || !config) {
    return;
  }
  catalogSection.hidden = false;
  catalogList.replaceChildren();
  catalogBaseUrl = config.baseUrl ?? null;
  if (!config.baseUrl) {
    catalogNote.textContent =
      'This Jupyter page does not report its base URL, so extensions cannot be selected for it.';
    catalogNote.hidden = false;
    applyCatalog.hidden = true;
    return;
  }
  catalogNote.hidden = true;
  applyCatalog.hidden = false;

  const packages = await loadedPackages();
  const selected = selectionFor(
    snapshot.selection,
    config.baseUrl,
    packages.map(pkg => pkg.id)
  );
  const decision = decideInjection(config, selected);
  const sources = parseSources(snapshot.sources);
  for (const entry of CATALOG) {
    const item = document.createElement('li');
    const state = decision.catalog[entry.id];
    if (entry.role === 'extension') {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = entry.id;
      box.checked = selected.has(entry.id);
      label.append(box, ` ${entry.label}`);
      item.append(label);
    } else {
      item.append(entry.label);
    }
    const lines = catalogDetails(entry.id, state);
    const source = sourceDetail(entry.id, sources);
    if (source) {
      lines.push(source);
    }
    const detail = document.createElement('div');
    detail.className = 'status-detail';
    detail.textContent = lines.join('. ');
    item.append(detail);
    catalogList.append(item);
  }
  for (const pkg of packages) {
    const item = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = pkg.id;
    box.checked = selected.has(pkg.id);
    label.append(box, ` ${pkg.name} ${pkg.version}`);
    item.append(label);
    const lines = [`Runtime package from PyPI, federation ${pkg.federation}`];
    const source = sourceDetail(pkg.id, sources);
    if (source) {
      lines.push(source);
    } else if (box.checked) {
      lines.push('Not loaded on this page; reload after saving');
    }
    const detail = document.createElement('div');
    detail.className = 'status-detail';
    detail.textContent = lines.join('. ');
    item.append(detail);
    catalogList.append(item);
  }
}

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  origin = webOrigin(tab?.url);
  if (origin === null) {
    originLabel.textContent = 'This page cannot be extended.';
    return;
  }
  originLabel.textContent = origin;
  await refresh();
}

toggle.addEventListener('click', () => {
  if (origin === null || tabId === undefined) {
    return;
  }
  const currentOrigin = origin;
  const enabledNow = toggle.dataset.enabled === 'true';
  if (enabledNow) {
    void (async () => {
      await chrome.runtime.sendMessage({ type: 'disable', origin: currentOrigin });
      showMessage('Disabled. Reload the page to stop the runtime.');
      await refresh();
    })();
    return;
  }
  // Requested synchronously in the click handler to keep the user gesture.
  chrome.permissions.request(
    { origins: [originPattern(currentOrigin)] },
    granted => {
      if (!granted) {
        showMessage(`Permission for ${currentOrigin} was not granted.`, true);
        return;
      }
      void (async () => {
        const result = (await chrome.runtime.sendMessage({
          type: 'enable',
          origin: currentOrigin
        })) as { ok: boolean; error?: string };
        if (!result.ok) {
          showMessage(result.error ?? 'Could not enable.', true);
          return;
        }
        showMessage('Enabled. Reload the page to load the runtime.');
        reload.hidden = false;
        await refresh();
      })();
    }
  );
});

reload.addEventListener('click', () => {
  if (tabId !== undefined) {
    void chrome.tabs.reload(tabId);
  }
  window.close();
});

applyCatalog.addEventListener('click', () => {
  const id = tabId;
  const baseUrl = catalogBaseUrl;
  if (id === undefined || baseUrl === null) {
    return;
  }
  const states: Record<string, boolean> = {};
  for (const box of catalogList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    states[box.value] = box.checked;
  }
  void (async () => {
    const saved = await writeSelection(id, serializeSelection(baseUrl, states));
    if (!saved) {
      showMessage('Could not save the selection for this page.', true);
      return;
    }
    showMessage(
      'Saved. Reload the page to load the selected extensions. Unsaved notebook changes may be lost on reload.'
    );
    reload.hidden = false;
    await refresh();
  })();
});

void init();
