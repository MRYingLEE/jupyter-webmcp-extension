/**
 * Settings for the injected WebMCP plugin.
 *
 * The runtime runs in the page, so it cannot read the extension's storage. It
 * asks the isolated bridge for the stored values instead, and falls back to
 * the defaults of the upstream schema when the bridge does not answer.
 */

import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Signal } from '@lumino/signaling';
import {
  SETTINGS_CHANGED,
  SETTINGS_REQUEST,
  SETTINGS_RESPONSE
} from './channel';
import { normalizeSettings, WEBMCP_DEFAULTS } from './webmcp-settings';

export { normalizeSettings, WEBMCP_DEFAULTS };

/** How long to wait for the bridge before using the defaults. */
const REQUEST_TIMEOUT_MS = 2000;

/**
 * A settings object with the subset of `ISettingRegistry.ISettings` that the
 * WebMCP manager uses (`composite`, `default`, and `changed`).
 */
export class RuntimeSettings {
  constructor(stored: Record<string, unknown>) {
    this._stored = stored;
  }

  /**
   * Load the stored settings through the bridge, using the defaults when the
   * bridge does not answer in time.
   */
  static load(): Promise<RuntimeSettings> {
    return new Promise<RuntimeSettings>(resolve => {
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        document.removeEventListener(SETTINGS_RESPONSE, onResponse);
        resolve(new RuntimeSettings({}));
      }, REQUEST_TIMEOUT_MS);
      const onResponse = (event: Event): void => {
        const detail = parseDetail((event as CustomEvent).detail);
        if (detail?.nonce !== nonce) {
          return;
        }
        clearTimeout(timer);
        document.removeEventListener(SETTINGS_RESPONSE, onResponse);
        resolve(new RuntimeSettings(normalizeSettings(detail.settings)));
      };
      document.addEventListener(SETTINGS_RESPONSE, onResponse);
      document.dispatchEvent(
        new CustomEvent(SETTINGS_REQUEST, {
          detail: JSON.stringify({ nonce })
        })
      );
    });
  }

  /**
   * Signal emitted when the stored settings change.
   */
  get changed(): Signal<this, unknown> {
    return this._changed;
  }

  /**
   * The effective values: the defaults, overridden by the stored values.
   */
  get composite(): Record<string, unknown> {
    return { ...WEBMCP_DEFAULTS, ...this._stored };
  }

  /**
   * The default value of a setting.
   */
  default(key: string): unknown {
    return WEBMCP_DEFAULTS[key];
  }

  /**
   * Listen to live updates of the stored settings.
   */
  listen(): void {
    document.addEventListener(SETTINGS_CHANGED, this._onChanged);
  }

  /**
   * Stop listening to updates.
   */
  dispose(): void {
    document.removeEventListener(SETTINGS_CHANGED, this._onChanged);
    Signal.clearData(this);
  }

  private _onChanged = (event: Event): void => {
    const detail = parseDetail((event as CustomEvent).detail);
    this._stored = normalizeSettings(detail?.settings);
    this._changed.emit(undefined);
  };

  private _changed = new Signal<this, unknown>(this);
  private _stored: Record<string, unknown>;
}

/**
 * Cast the adapter to the registry settings type expected by the upstream
 * manager. Only the members listed in the class are used at runtime.
 */
export function asRegistrySettings(
  settings: RuntimeSettings
): ISettingRegistry.ISettings {
  return settings as unknown as ISettingRegistry.ISettings;
}

function parseDetail(detail: unknown): Record<string, any> | null {
  if (typeof detail !== 'string') {
    return null;
  }
  try {
    const value = JSON.parse(detail);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
