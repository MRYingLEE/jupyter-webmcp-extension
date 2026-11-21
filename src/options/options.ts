/**
 * Options page: the WebMCP settings (validated on save) and the list of
 * enabled sites.
 */

import { ENABLED_ORIGINS_KEY, SETTINGS_STORAGE_KEY } from '../shared/storage';
import { normalizeSettings, WEBMCP_DEFAULTS } from '../../runtime/src/webmcp-settings';
import { originPattern } from '../shared/origin';
import { PYPI_ORIGINS } from '../shared/pypi';
import type { IRuntimeCatalogState } from '../shared/messages';

interface IStateResponse {
  ok: boolean;
  state?: IRuntimeCatalogState;
  error?: string;
}

const settingsText = document.getElementById('settings') as HTMLTextAreaElement;
const save = document.getElementById('save') as HTMLButtonElement;
const reset = document.getElementById('reset') as HTMLButtonElement;
const message = document.getElementById('message') as HTMLElement;
const sites = document.getElementById('sites') as HTMLElement;
const noSites = document.getElementById('no-sites') as HTMLElement;
const packageName = document.getElementById('package-name') as HTMLInputElement;
const packageVersion = document.getElementById('package-version') as HTMLInputElement;
const loadPackage = document.getElementById('load-package') as HTMLButtonElement;
const packageMessage = document.getElementById('package-message') as HTMLElement;
const packageState = document.getElementById('package-state') as HTMLElement;

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

function showPackageMessage(lines: string[], error = false): void {
  packageMessage.replaceChildren(
    ...lines.map(line => {
      const row = document.createElement('div');
      row.textContent = line;
      return row;
    })
  );
  packageMessage.className = error ? 'message error' : 'message';
  packageMessage.hidden = lines.length === 0;
}

function renderPackageState(state: IRuntimeCatalogState): void {
  packageState.replaceChildren();
  if (state.packages.length === 0) {
    const item = document.createElement('li');
    item.className = 'muted';
    item.textContent = 'No runtime packages are loaded. The bundled builds are used.';
    packageState.append(item);
    return;
  }
  for (const pkg of state.packages) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${pkg.name} ${pkg.version} (federation: ${pkg.federation}) `;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Remove';
    button.addEventListener('click', () => {
      void (async () => {
        const response = (await chrome.runtime.sendMessage({
          type: 'unloadRuntimePackage',
          id: pkg.id
        })) as IStateResponse;
        if (!response.ok || !response.state) {
          showPackageMessage([response.error ?? 'Could not remove the package.'], true);
          return;
        }
        showPackageMessage([`Removed ${pkg.name}. Reload open Jupyter pages to apply.`]);
        renderPackageState(response.state);
      })();
    });
    item.append(label, button);
    packageState.append(item);
  }
}

async function loadPackageState(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: 'runtimeCatalogState'
  })) as IStateResponse;
  if (!response.ok || !response.state) {
    showPackageMessage([response.error ?? 'Could not read the loaded packages.'], true);
    return;
  }
  renderPackageState(response.state);
}

loadPackage.addEventListener('click', () => {
  const name = packageName.value.trim();
  const version = packageVersion.value.trim();
  if (!name || !version) {
    showPackageMessage(['Enter a PyPI package name and a version.'], true);
    return;
  }
  // Requested synchronously in the click handler to keep the user gesture.
  chrome.permissions.request({ origins: PYPI_ORIGINS.map(origin => originPattern(origin)) }, granted => {
    if (!granted) {
      showPackageMessage(['Permission to read pypi.org and files.pythonhosted.org was not granted.'], true);
      return;
    }
    void (async () => {
      loadPackage.disabled = true;
      try {
        const response = (await chrome.runtime.sendMessage({
          type: 'loadRuntimePackage',
          name,
          version
        })) as IStateResponse;
        if (!response.ok || !response.state) {
          showPackageMessage([response.error ?? 'Could not load the package.'], true);
          return;
        }
        showPackageMessage([
          `Loaded ${name} ${version}. Reload open Jupyter pages, then enable it in the popup.`
        ]);
        renderPackageState(response.state);
      } finally {
        loadPackage.disabled = false;
      }
    })();
  });
});

void loadSettings();
void renderSites();
void loadPackageState();
