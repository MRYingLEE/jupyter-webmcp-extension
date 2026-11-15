/**
 * The ISOLATED-world bridge, run at `document_start` on enabled origins.
 *
 * It sets the runtime base URL for the MAIN-world hook, answers the runtime's
 * settings requests from extension storage, and forwards runtime status to the
 * service worker. The page cannot reach the extension APIs directly.
 */

import {
  RUNTIME_BASE_ATTRIBUTE,
  SETTINGS_CHANGED,
  SETTINGS_REQUEST,
  SETTINGS_RESPONSE,
  STATUS_EVENT,
  IRuntimeStatus
} from '../../runtime/src/channel';
import { isRecord } from '../shared/config';
import { allowsTools, mayGrantRuntime } from '../shared/frame-policy';
import { ENABLED_ORIGINS_KEY, SETTINGS_STORAGE_KEY } from '../shared/storage';
import { ExtensionMessage } from '../shared/messages';

const runtimeBase = chrome.runtime.getURL('runtime/');

function setRuntimeBase(): boolean {
  const root = document.documentElement;
  if (!root) {
    return false;
  }
  root.setAttribute(RUNTIME_BASE_ATTRIBUTE, runtimeBase);
  return true;
}

function grantRuntime(): void {
  if (setRuntimeBase()) {
    return;
  }
  const observer = new MutationObserver(() => {
    if (setRuntimeBase()) {
      observer.disconnect();
    }
  });
  observer.observe(document, { childList: true, subtree: true });
}

async function frameMayBeGranted(): Promise<boolean> {
  const stored = await chrome.storage.local.get(ENABLED_ORIGINS_KEY);
  const value = stored[ENABLED_ORIGINS_KEY];
  const enabledOrigins = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  return mayGrantRuntime({
    isTop: false,
    allowsTools: allowsTools(document),
    origin: location.origin,
    ancestorOrigins: Array.from(location.ancestorOrigins),
    enabledOrigins
  });
}

if (window.top === window) {
  grantRuntime();
} else {
  // Embedded frames are granted only after the storage check. Until then the
  // base is absent, so the runtime entry is not mapped and does not load.
  void frameMayBeGranted().then(allowed => {
    if (allowed) {
      grantRuntime();
    }
  });
}


async function readSettings(): Promise<unknown> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return stored[SETTINGS_STORAGE_KEY] ?? {};
}

document.addEventListener(SETTINGS_REQUEST, event => {
  const request = parseDetail((event as CustomEvent).detail);
  const nonce = request?.nonce;
  if (typeof nonce !== 'string') {
    return;
  }
  void readSettings().then(
    settings => {
      document.dispatchEvent(
        new CustomEvent(SETTINGS_RESPONSE, {
          detail: JSON.stringify({ nonce, settings })
        })
      );
    },
    (error: unknown) => {
      console.error('Unable to read WebMCP settings:', error);
    }
  );
});

chrome.storage.onChanged.addListener((changes, area) => {
  const change = changes[SETTINGS_STORAGE_KEY];
  if (area !== 'local' || !change) {
    return;
  }
  document.dispatchEvent(
    new CustomEvent(SETTINGS_CHANGED, {
      detail: JSON.stringify({ settings: change.newValue ?? {} })
    })
  );
});

document.addEventListener(STATUS_EVENT, event => {
  const status = parseStatus((event as CustomEvent).detail);
  if (!status) {
    return;
  }
  const message: ExtensionMessage = { type: 'status', status };
  chrome.runtime.sendMessage(message).catch(() => {
    // The service worker is gone (for example, after the extension reloaded).
  });
});

function parseDetail(detail: unknown): Record<string, unknown> | null {
  if (typeof detail !== 'string') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(detail);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseStatus(detail: unknown): IRuntimeStatus | null {
  const parsed = parseDetail(detail);
  if (!parsed) {
    return null;
  }
  const { component, state } = parsed;
  if (component !== 'ai' && component !== 'webmcp' && component !== 'runtime') {
    return null;
  }
  if (state !== 'active' && state !== 'failed') {
    return null;
  }
  const status: IRuntimeStatus = { component, state };
  if (typeof parsed.detail === 'string') {
    status.detail = parsed.detail.slice(0, 500);
  }
  return status;
}
