/**
 * Options page: the WebMCP settings (validated on save) and the list of
 * enabled sites.
 */

import { ENABLED_ORIGINS_KEY, SETTINGS_STORAGE_KEY } from '../shared/storage';
import { normalizeSettings, WEBMCP_DEFAULTS } from '../../runtime/src/webmcp-settings';
import { originPattern } from '../shared/origin';
import type { IRuntimeCatalogState } from '../shared/messages';

const settingsText = document.getElementById('settings') as HTMLTextAreaElement;
const save = document.getElementById('save') as HTMLButtonElement;
const reset = document.getElementById('reset') as HTMLButtonElement;
const message = document.getElementById('message') as HTMLElement;
const sites = document.getElementById('sites') as HTMLElement;
const noSites = document.getElementById('no-sites') as HTMLElement;
const manifestInput = document.getElementById('manifest-url') as HTMLInputElement;
const fetchCatalog = document.getElementById('fetch-catalog') as HTMLButtonElement;
const clearCatalog = document.getElementById('clear-catalog') as HTMLButtonElement;
const catalogMessage = document.getElementById('catalog-message') as HTMLElement;
const catalogState = document.getElementById('catalog-state') as HTMLElement;

function showMessage(lines: string[], error = false): void {
  message.replaceChildren(
    ...lines.map(line => {
      const row = document.createElement('div');
      row.textContent = line;
      return row;
    })
  );
  message.className = error ? 'message error' : 'message';
  message.hidden = lines.length === 0;
}

async function loadSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const current = normalizeSettings(stored[SETTINGS_STORAGE_KEY]);
  const shown = { ...WEBMCP_DEFAULTS, ...current };
  settingsText.value = JSON.stringify(shown, null, 2);
}

/** Describe the keys of the input that the validator dropped or changed. */
function droppedKeys(parsed: Record<string, unknown>, normalized: Record<string, unknown>): string[] {
  const notes: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in WEBMCP_DEFAULTS)) {
      notes.push(`Unknown setting "${key}" was ignored.`);
    } else if (JSON.stringify(normalized[key]) !== JSON.stringify(value)) {
      notes.push(`Invalid value for "${key}" was replaced by the valid part or default.`);
    }
  }
  return notes;
}

save.addEventListener('click', () => {
  void (async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(settingsText.value);
    } catch (error) {
      showMessage([`Not valid JSON: ${String(error)}`], true);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      showMessage(['Settings must be a JSON object.'], true);
      return;
    }
    const record = parsed as Record<string, unknown>;
    const normalized = normalizeSettings(record);
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized });
    showMessage(['Saved.', ...droppedKeys(record, normalized)]);
    await loadSettings();
  })();
});

reset.addEventListener('click', () => {
  void (async () => {
    await chrome.storage.local.remove(SETTINGS_STORAGE_KEY);
    showMessage(['Reset to defaults.']);
    await loadSettings();
  })();
});

async function renderSites(): Promise<void> {
  const stored = await chrome.storage.local.get(ENABLED_ORIGINS_KEY);
  const origins = Array.isArray(stored[ENABLED_ORIGINS_KEY])
    ? (stored[ENABLED_ORIGINS_KEY] as string[])
    : [];
  sites.replaceChildren();
  noSites.hidden = origins.length > 0;
  for (const origin of origins) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${origin} `;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Disable';
    button.addEventListener('click', () => {
      void (async () => {
        await chrome.runtime.sendMessage({ type: 'disable', origin });
        await renderSites();
      })();
    });
    item.append(label, button);
    sites.append(item);
  }
}

/** The manifest URL when it is https, or http on localhost; otherwise null. */
function manifestUrlOf(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url : null;
}

function showCatalogMessage(lines: string[], error = false): void {
  catalogMessage.replaceChildren(
    ...lines.map(line => {
      const row = document.createElement('div');
      row.textContent = line;
      return row;
    })
  );
  catalogMessage.className = error ? 'message error' : 'message';
  catalogMessage.hidden = lines.length === 0;
}

function renderCatalogState(state: IRuntimeCatalogState): void {
  catalogState.replaceChildren();
  if (!state.manifestUrl) {
    const item = document.createElement('li');
    item.className = 'muted';
    item.textContent = 'No runtime catalog is stored. The bundled builds are used.';
    catalogState.append(item);
    return;
  }
  const lines = [`Manifest: ${state.manifestUrl}`];
  if (state.fetchedAt !== undefined) {
    lines.push(`Fetched: ${new Date(state.fetchedAt).toLocaleString()}`);
  }
  for (const [id, version] of Object.entries(state.versions)) {
    lines.push(`${id}: verified ${version}`);
  }
  for (const line of lines) {
    const item = document.createElement('li');
    item.textContent = line;
    catalogState.append(item);
  }
}

async function loadCatalogState(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: 'runtimeCatalogState'
  })) as { ok: boolean; state?: IRuntimeCatalogState; error?: string };
  if (!response.ok || !response.state) {
    showCatalogMessage([response.error ?? 'Could not read the runtime catalog.'], true);
    return;
  }
  manifestInput.value = response.state.manifestUrl ?? '';
  renderCatalogState(response.state);
}

fetchCatalog.addEventListener('click', () => {
  const url = manifestUrlOf(manifestInput.value.trim());
  if (!url) {
    showCatalogMessage(
      ['Enter an https:// manifest URL. http:// is allowed only for localhost.'],
      true
    );
    return;
  }
  // Requested synchronously in the click handler to keep the user gesture.
  chrome.permissions.request({ origins: [originPattern(url.origin)] }, granted => {
    if (!granted) {
      showCatalogMessage([`Permission to read ${url.origin} was not granted.`], true);
      return;
    }
    void (async () => {
      fetchCatalog.disabled = true;
      try {
        const response = (await chrome.runtime.sendMessage({
          type: 'refreshRuntimeCatalog',
          manifestUrl: url.href
        })) as { ok: boolean; state?: IRuntimeCatalogState; error?: string };
        if (!response.ok || !response.state) {
          showCatalogMessage([response.error ?? 'Could not fetch the runtime catalog.'], true);
          return;
        }
        showCatalogMessage([
          'Verified and stored. Reload open Jupyter pages to load the runtime.'
        ]);
        renderCatalogState(response.state);
      } finally {
        fetchCatalog.disabled = false;
      }
    })();
  });
});

clearCatalog.addEventListener('click', () => {
  void (async () => {
    const response = (await chrome.runtime.sendMessage({
      type: 'clearRuntimeCatalog'
    })) as { ok: boolean; error?: string };
    if (!response.ok) {
      showCatalogMessage([response.error ?? 'Could not clear the runtime catalog.'], true);
      return;
    }
    showCatalogMessage(['Cleared. Pages use the bundled builds after they reload.']);
    await loadCatalogState();
  })();
});

void loadSettings();
void renderSites();
void loadCatalogState();
