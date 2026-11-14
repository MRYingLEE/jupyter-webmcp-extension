/**
 * The extension service worker: per-origin enablement, dynamic content script
 * registration, per-tab status, and the toolbar badge.
 */

import { ENABLED_ORIGINS_KEY } from '../shared/storage';
import { isWebOrigin, originPattern, webOrigin } from '../shared/origin';
import type {
  ExtensionMessage,
  IStateResponse,
  ITabStatus
} from '../shared/messages';
import type { IRuntimeStatus } from '../../runtime/src/channel';

const TAB_STATUS_KEY = 'tabStatus';
const FRAME_STATUS_KEY = 'frameStatus';

/** Stable registration ids, one per world and origin. */
function scriptIds(origin: string): string[] {
  return [`jwe-main ${origin}`, `jwe-bridge ${origin}`];
}

async function enabledOrigins(): Promise<string[]> {
  const stored = await chrome.storage.local.get(ENABLED_ORIGINS_KEY);
  const value = stored[ENABLED_ORIGINS_KEY];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

async function saveEnabledOrigins(origins: string[]): Promise<void> {
  await chrome.storage.local.set({ [ENABLED_ORIGINS_KEY]: origins });
}

/** Remove the content scripts registered for an origin, if any. */
async function unregisterOrigin(origin: string): Promise<void> {
  const ids = scriptIds(origin);
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids });
  if (registered.length > 0) {
    await chrome.scripting.unregisterContentScripts({
      ids: registered.map(script => script.id)
    });
  }
}

/**
 * Register the MAIN-world hook and the ISOLATED bridge for an origin, in every
 * frame. Embedded frames are gated by the `tools` permission in both scripts.
 */
async function registerOrigin(origin: string): Promise<void> {
  await unregisterOrigin(origin);
  const [mainId, bridgeId] = scriptIds(origin);
  const matches = [originPattern(origin)];
  await chrome.scripting.registerContentScripts([
    {
      id: mainId,
      matches,
      js: ['content-main.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true
    },
    {
      id: bridgeId,
      matches,
      js: ['content-bridge.js'],
      runAt: 'document_start',
      world: 'ISOLATED',
      allFrames: true
    }
  ]);
}

async function hasPermission(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [originPattern(origin)] });
}

/**
 * Re-register the enabled origins whose permission is still granted, and drop
 * the others from the list.
 */
async function reconcile(): Promise<void> {
  const kept: string[] = [];
  for (const origin of await enabledOrigins()) {
    if (await hasPermission(origin)) {
      await registerOrigin(origin);
      kept.push(origin);
    } else {
      await unregisterOrigin(origin);
    }
  }
  await saveEnabledOrigins(kept);
}

async function enable(origin: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await hasPermission(origin))) {
    return { ok: false, error: `Permission for ${origin} is not granted.` };
  }
  await registerOrigin(origin);
  const origins = await enabledOrigins();
  if (!origins.includes(origin)) {
    origins.push(origin);
    await saveEnabledOrigins(origins);
  }
  return { ok: true };
}

async function disable(origin: string): Promise<void> {
  await unregisterOrigin(origin);
  await saveEnabledOrigins(
    (await enabledOrigins()).filter(item => item !== origin)
  );
}

async function readTabStatuses(): Promise<Record<string, ITabStatus>> {
  const stored = await chrome.storage.session.get(TAB_STATUS_KEY);
  return (stored[TAB_STATUS_KEY] as Record<string, ITabStatus>) ?? {};
}

async function writeTabStatuses(
  statuses: Record<string, ITabStatus>
): Promise<void> {
  await chrome.storage.session.set({ [TAB_STATUS_KEY]: statuses });
}

/** Embedded frame statuses, by tab id and then by frame id. */
async function readFrameStatuses(): Promise<Record<string, Record<string, ITabStatus>>> {
  const stored = await chrome.storage.session.get(FRAME_STATUS_KEY);
  return (stored[FRAME_STATUS_KEY] as Record<string, Record<string, ITabStatus>>) ?? {};
}

async function writeFrameStatuses(
  statuses: Record<string, Record<string, ITabStatus>>
): Promise<void> {
  await chrome.storage.session.set({ [FRAME_STATUS_KEY]: statuses });
}

/** The status of a frame after one component report, keeping its other components. */
function withComponent(
  current: ITabStatus | undefined,
  origin: string,
  documentId: string | undefined,
  status: IRuntimeStatus
): ITabStatus {
  const sameDocument =
    current?.origin === origin && current.documentId === documentId;
  const components = { ...(sameDocument ? current.components : {}) };
  components[status.component] = {
    state: status.state,
    ...(status.detail === undefined ? {} : { detail: status.detail })
  };
  return { origin, documentId, components, updated: Date.now() };
}

async function recordStatus(
  tabId: number,
  frameId: number,
  origin: string,
  documentId: string | undefined,
  status: IRuntimeStatus
): Promise<void> {
  if (frameId === 0) {
    const statuses = await readTabStatuses();
    statuses[tabId] = withComponent(statuses[tabId], origin, documentId, status);
    await writeTabStatuses(statuses);
  } else {
    // An embedded frame is kept apart so it cannot replace the top frame's components.
    const frames = await readFrameStatuses();
    const tabFrames = frames[tabId] ?? {};
    tabFrames[frameId] = withComponent(tabFrames[frameId], origin, documentId, status);
    frames[tabId] = tabFrames;
    await writeFrameStatuses(frames);
  }
  await updateBadge(tabId);
}

async function clearTab(tabId: number): Promise<void> {
  const statuses = await readTabStatuses();
  if (tabId in statuses) {
    delete statuses[tabId];
    await writeTabStatuses(statuses);
  }
  const frames = await readFrameStatuses();
  if (tabId in frames) {
    delete frames[tabId];
    await writeFrameStatuses(frames);
  }
  await chrome.action.setBadgeText({ tabId, text: '' });
}

/** The badge shows the worst state across the top frame and its embedded frames. */
async function updateBadge(tabId: number): Promise<void> {
  const top = (await readTabStatuses())[tabId];
  const frames = Object.values((await readFrameStatuses())[tabId] ?? {});
  const states = [top, ...frames].flatMap(source =>
    Object.values(source?.components ?? {}).map(info => info?.state)
  );
  if (states.length === 0) {
    await chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  const failed = states.includes('failed');
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: failed ? '#c62828' : '#2e7d32'
  });
  await chrome.action.setBadgeText({ tabId, text: failed ? '!' : 'ON' });
}

/**
 * Whether the message comes from one of this extension's pages (popup or
 * options). Extension pages opened in a tab also have `sender.tab`, so the
 * URL is checked instead. A content script's `sender.url` is the page's URL.
 */
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.url?.startsWith(chrome.runtime.getURL('')) === true
  );
}

/**
 * Only the extension's own pages may change enablement or read tab state.
 * Content scripts may only report status, and only for their own tab.
 */
async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  switch (message.type) {
    case 'status': {
      const tabId = sender.tab?.id;
      const origin = webOrigin(sender.url);
      if (sender.id === chrome.runtime.id && tabId !== undefined && origin) {
        await recordStatus(
          tabId,
          sender.frameId ?? 0,
          origin,
          sender.documentId,
          message.status
        );
      }
      return { ok: true };
    }
    case 'enable':
      if (!isExtensionPage(sender) || !isWebOrigin(message.origin)) {
        return { ok: false, error: 'Not allowed.' };
      }
      return enable(message.origin);
    case 'disable':
      if (!isExtensionPage(sender) || !isWebOrigin(message.origin)) {
        return { ok: false, error: 'Not allowed.' };
      }
      await disable(message.origin);
      return { ok: true };
    case 'state': {
      if (!isExtensionPage(sender) || !isWebOrigin(message.origin)) {
        return { ok: false, error: 'Not allowed.' };
      }
      const enabled = (await enabledOrigins()).includes(message.origin);
      const statuses = await readTabStatuses();
      const frames = (await readFrameStatuses())[message.tabId] ?? {};
      const response: IStateResponse = {
        enabled,
        embedded: Object.entries(frames).map(([frameId, status]) => ({
          ...status,
          frameId: Number(frameId)
        }))
      };
      const status = statuses[message.tabId];
      if (status?.origin === message.origin) {
        response.status = status;
      }
      return response;
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void reconcile();
});

chrome.runtime.onStartup.addListener(() => {
  void reconcile();
});

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(
      response => sendResponse(response),
      (error: unknown) => sendResponse({ ok: false, error: String(error) })
    );
    return true;
  }
);

// Tab 'loading' events can arrive after the new page has already reported, so
// only a navigation to a different origin clears the tab's status.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === undefined) {
    return;
  }
  void readTabStatuses().then(statuses => {
    const status = statuses[tabId];
    if (status && status.origin !== webOrigin(changeInfo.url)) {
      return clearTab(tabId);
    }
    return undefined;
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  void clearTab(tabId);
});
