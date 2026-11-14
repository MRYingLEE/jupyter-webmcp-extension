import { describe, expect, it } from 'vitest';

import { isWebOrigin } from '../src/shared/origin';

describe('isWebOrigin', () => {
  it('accepts only exact http(s) origins', () => {
    expect(isWebOrigin('https://jupyter.example.org')).toBe(true);
    expect(isWebOrigin('http://localhost:8888')).toBe(true);
  });

  it('rejects paths, wildcards, other schemes, and non-strings', () => {
    expect(isWebOrigin('https://jupyter.example.org/lab')).toBe(false);
    expect(isWebOrigin('http://*')).toBe(false);
    expect(isWebOrigin('chrome-extension://abcdef')).toBe(false);
    expect(isWebOrigin('javascript:alert(1)')).toBe(false);
    expect(isWebOrigin(undefined)).toBe(false);
  });
});
