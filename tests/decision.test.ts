import { describe, expect, it } from 'vitest';

import {
  AI_COMMANDS_PACKAGE,
  IPageConfig,
  RUNTIME_CONFIG_KEY,
  RUNTIME_PACKAGE,
  WEBMCP_PACKAGE
} from '../src/shared/config';
import { decideInjection, injectRuntime } from '../src/shared/decision';

function pageConfig(overrides: Partial<IPageConfig> = {}): IPageConfig {
  return {
    appName: 'JupyterLab',
    fullLabextensionsUrl: 'http://localhost:8888/lab/extensions',
    federated_extensions: [{ name: 'jupyterlab_pygments', load: 'remoteEntry.js' }],
    ...overrides
  };
}

const LOAD = 'static/remoteEntry.abc.js';

describe('decideInjection', () => {
  it('injects both components when the page loads neither', () => {
    expect(decideInjection(pageConfig())).toEqual({ ai: 'injected', webmcp: 'injected' });
  });

  it('defers to a native copy of a component', () => {
    const config = pageConfig({
      federated_extensions: [{ name: AI_COMMANDS_PACKAGE, load: 'remoteEntry.js' }]
    });
    expect(decideInjection(config)).toEqual({ ai: 'native', webmcp: 'injected' });
  });

  it('lets disabledExtensions win over a native copy', () => {
    const config = pageConfig({
      federated_extensions: [{ name: WEBMCP_PACKAGE, load: 'remoteEntry.js' }],
      disabledExtensions: [WEBMCP_PACKAGE]
    });
    expect(decideInjection(config).webmcp).toBe('disabled');
  });
});

describe('injectRuntime', () => {
  it('adds the runtime entry and the decision the runtime reads', () => {
    const config = pageConfig();
    const result = injectRuntime(config, decideInjection(config), LOAD);

    expect(result.federated_extensions.at(-1)).toEqual({
      name: RUNTIME_PACKAGE,
      load: LOAD,
      extension: './extension'
    });
    expect(result[RUNTIME_CONFIG_KEY]).toEqual({ ai: true, webmcp: true });
  });

  it('is idempotent on a second read', () => {
    const config = pageConfig();
    const once = injectRuntime(config, decideInjection(config), LOAD);
    const twice = injectRuntime(once, decideInjection(once), LOAD);
    expect(twice).toBe(once);
  });

  it('returns the configuration unchanged when nothing is injected', () => {
    const config = pageConfig({
      federated_extensions: [
        { name: AI_COMMANDS_PACKAGE, load: 'remoteEntry.js' },
        { name: WEBMCP_PACKAGE, load: 'remoteEntry.js' }
      ]
    });
    expect(injectRuntime(config, decideInjection(config), LOAD)).toBe(config);
  });
});
