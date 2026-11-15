import { describe, expect, it } from 'vitest';

import {
  federatedEntryUrl,
  isExtensionDisabled,
  parsePageConfig
} from '../src/shared/config';
import { webOrigin } from '../src/shared/origin';

describe('parsePageConfig', () => {
  it('accepts a JupyterLab server page configuration', () => {
    const text = JSON.stringify({
      appName: 'JupyterLab',
      fullLabextensionsUrl: '/lab/extensions',
      federated_extensions: []
    });
    expect(parsePageConfig(text)?.appName).toBe('JupyterLab');
  });

  it('accepts a page configuration that carries only appVersion', () => {
    const text = JSON.stringify({
      appVersion: '4.0.0',
      fullLabextensionsUrl: '/lab/extensions',
      federated_extensions: []
    });
    expect(parsePageConfig(text)).not.toBeNull();
  });

  it('rejects text that is not a Jupyter page configuration', () => {
    expect(parsePageConfig('not json')).toBeNull();
    expect(parsePageConfig(JSON.stringify({ appName: 'x', fullLabextensionsUrl: '/a' }))).toBeNull();
    expect(
      parsePageConfig(JSON.stringify({ appName: 'x', federated_extensions: [] }))
    ).toBeNull();
  });
});

describe('federatedEntryUrl', () => {
  it('joins the extensions URL and the entry without a double slash', () => {
    expect(
      federatedEntryUrl({ fullLabextensionsUrl: 'http://h/lab/extensions/' }, 'pkg', 'remoteEntry.js')
    ).toBe('http://h/lab/extensions/pkg/remoteEntry.js');
  });
});

describe('isExtensionDisabled', () => {
  it('reads both the list and the map forms of disabledExtensions', () => {
    expect(isExtensionDisabled({ disabledExtensions: ['a'] }, 'a')).toBe(true);
    expect(isExtensionDisabled({ disabledExtensions: { a: true } }, 'a')).toBe(true);
    expect(isExtensionDisabled({ disabledExtensions: { a: false } }, 'a')).toBe(false);
    expect(isExtensionDisabled({}, 'a')).toBe(false);
  });

  it('matches a plugin id or its extension, including JSON-encoded lists', () => {
    expect(isExtensionDisabled({ disabledExtensions: ['a:plugin'] }, 'a:plugin')).toBe(true);
    expect(isExtensionDisabled({ disabledExtensions: ['a'] }, 'a:plugin')).toBe(true);
    expect(isExtensionDisabled({ disabledExtensions: '["a:plugin"]' }, 'a:plugin')).toBe(true);
    expect(isExtensionDisabled({ disabledExtensions: { 'a:plugin': true } }, 'a:plugin')).toBe(true);
    expect(isExtensionDisabled({ disabledExtensions: ['a:other'] }, 'a:plugin')).toBe(false);
    expect(isExtensionDisabled({ disabledExtensions: 'invalid' }, 'a:plugin')).toBe(false);
  });
});

describe('webOrigin', () => {
  it('keeps only the origin of web URLs', () => {
    expect(webOrigin('http://localhost:8888/lab?x=1')).toBe('http://localhost:8888');
    expect(webOrigin('chrome-extension://abc/options.html')).toBeNull();
    expect(webOrigin(undefined)).toBeNull();
  });
});
