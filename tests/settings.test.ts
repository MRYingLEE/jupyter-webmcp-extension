import { describe, expect, it } from 'vitest';

import { normalizeSettings } from '../runtime/src/webmcp-settings';

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
