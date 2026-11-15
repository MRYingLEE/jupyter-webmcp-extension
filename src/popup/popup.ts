/**
 * Toolbar popup: shows the current site, its enablement, and the tab status,
 * and lets the user enable or disable the extension for the site.
 */

import type { IEmbeddedStatus, IStateResponse, ITabStatus } from '../shared/messages';
import { originPattern, webOrigin } from '../shared/origin';
import type { IRuntimeStatus } from '../../runtime/src/channel';

const originLabel = document.getElementById('origin') as HTMLElement;
const message = document.getElementById('message') as HTMLElement;
const toggle = document.getElementById('toggle') as HTMLButtonElement;
const reload = document.getElementById('reload') as HTMLButtonElement;
const statusList = document.getElementById('status') as HTMLElement;

const COMPONENT_LABELS: Record<IRuntimeStatus['component'], string> = {
  ai: 'AI commands',
  webmcp: 'WebMCP',
  runtime: 'Runtime'
};

let tabId: number | undefined;
let origin: string | null = null;

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
    const label = COMPONENT_LABELS[component as IRuntimeStatus['component']];
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

void init();
