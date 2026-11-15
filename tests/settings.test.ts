import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeSettings } from '../runtime/src/webmcp-settings';
import { RuntimeSettings } from '../runtime/src/settings';
import { SETTINGS_REQUEST, SETTINGS_RESPONSE } from '../runtime/src/channel';

describe('normalizeSettings', () => {
  it('keeps valid values and drops unknown keys and wrong types', () => {
    const result = normalizeSettings({
      disabledTools: ['a', 1, 'b'],
      unknownKey: true,
      executionTimeout: 'soon'
    });

    expect(result).toEqual({ disabledTools: ['a', 'b'] });
  });

  it('rejects out-of-range numbers so the defaults apply', () => {
    expect(normalizeSettings({ executionTimeout: 99999 })).toEqual({});
    expect(normalizeSettings({ maxResultLength: 10 })).toEqual({});
    expect(normalizeSettings({ maxResultLength: 5000 })).toEqual({ maxResultLength: 5000 });
  });

  it('returns no values for a non-object', () => {
    expect(normalizeSettings(['x'])).toEqual({});
    expect(normalizeSettings(null)).toEqual({});
  });
});

describe('RuntimeSettings.load', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses the settings returned by the bridge', async () => {
    const doc = new EventTarget();
    vi.stubGlobal('document', doc);
    doc.addEventListener(SETTINGS_REQUEST, event => {
      const { nonce } = JSON.parse((event as CustomEvent<string>).detail);
      doc.dispatchEvent(new CustomEvent(SETTINGS_RESPONSE, {
        detail: JSON.stringify({ nonce, settings: { blockedCommands: ['custom:*'] } })
      }));
    });

    const settings = await RuntimeSettings.load();
    expect(settings.composite.blockedCommands).toEqual(['custom:*']);
  });

  it('fails instead of starting with defaults when the bridge does not respond', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', new EventTarget());
    const result = RuntimeSettings.load();
    const assertion = expect(result).rejects.toThrow('Timed out waiting for WebMCP settings');
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });
});
