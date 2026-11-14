/**
 * Options page: the WebMCP settings (validated on save) and the list of
 * enabled sites.
 */

import { ENABLED_ORIGINS_KEY, SETTINGS_STORAGE_KEY } from '../shared/storage';
import { normalizeSettings, WEBMCP_DEFAULTS } from '../../runtime/src/webmcp-settings';

const settingsText = document.getElementById('settings') as HTMLTextAreaElement;
const save = document.getElementById('save') as HTMLButtonElement;
const reset = document.getElementById('reset') as HTMLButtonElement;
const message = document.getElementById('message') as HTMLElement;
const sites = document.getElementById('sites') as HTMLElement;
const noSites = document.getElementById('no-sites') as HTMLElement;

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

void loadSettings();
void renderSites();
