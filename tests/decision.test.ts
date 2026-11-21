import { describe, expect, it } from 'vitest';

import {
  AI_COMMANDS_PACKAGE,
  IPageConfig,
  RUNTIME_CONFIG_KEY,
  RUNTIME_PACKAGE,
  WEBMCP_PACKAGE
} from '../src/shared/config';
import { catalogEntry } from '../src/shared/catalog';
import { decideInjection, injectRuntime } from '../src/shared/decision';
import { selectionFor, serializeSelection } from '../src/shared/selection';

function pageConfig(overrides: Partial<IPageConfig> = {}): IPageConfig {
  return {
    appName: 'JupyterLab',
    fullLabextensionsUrl: 'http://localhost:8888/lab/extensions',
    federated_extensions: [{ name: 'jupyterlab_pygments', load: 'remoteEntry.js' }],
    ...overrides
  };
}

const LOAD = 'static/remoteEntry.abc.js';
const BUILDS = {
  'anywidget-0.11': { load: './static/remoteEntry.11.js', extension: './extension' },
  'anywidget-0.10': { load: './static/remoteEntry.10.js', extension: './extension' },
  'widget-manager': { load: './static/remoteEntry.wm.js', extension: './extension' }
};
const ANYWIDGET_11 = ['anywidget-0.11'];
const WIDGET_MANAGER_PLUGIN = catalogEntry('widget-manager')!.plugin;

describe('decideInjection', () => {
  it('injects both components when the page loads neither', () => {
    expect(decideInjection(pageConfig())).toMatchObject({ ai: 'injected', webmcp: 'injected' });
  });

  it('defers to a native copy of a component', () => {
    const config = pageConfig({
      federated_extensions: [{ name: AI_COMMANDS_PACKAGE, load: 'remoteEntry.js' }]
    });
    expect(decideInjection(config)).toMatchObject({ ai: 'native', webmcp: 'injected' });
  });

  it('leaves catalog entries unselected by default', () => {
    expect(decideInjection(pageConfig()).catalog).toEqual({
      'anywidget-0.11': 'unselected',
      'anywidget-0.10': 'unselected',
      'widget-manager': 'unselected'
    });
  });

  it('injects a selected anywidget line with its widget-manager dependency', () => {
    const decision = decideInjection(pageConfig(), new Set(ANYWIDGET_11));
    expect(decision.catalog).toMatchObject({
      'anywidget-0.11': 'injected',
      'anywidget-0.10': 'unselected',
      'widget-manager': 'injected'
    });
  });

  it('reports a selected anywidget line as a conflict with a native anywidget', () => {
    const config = pageConfig({
      federated_extensions: [{ name: 'anywidget', load: 'remoteEntry.js' }]
    });
    expect(decideInjection(config, new Set(ANYWIDGET_11)).catalog['anywidget-0.11']).toBe(
      'conflict'
    );
  });

  it('defers to a native widget-manager instead of injecting it', () => {
    const config = pageConfig({
      federated_extensions: [
        { name: catalogEntry('widget-manager')!.federation, load: 'remoteEntry.js' }
      ]
    });
    expect(decideInjection(config, new Set(ANYWIDGET_11)).catalog).toMatchObject({
      'anywidget-0.11': 'injected',
      'widget-manager': 'native'
    });
  });

  it('makes a selected anywidget unsupported when widget-manager is disabled', () => {
    const config = pageConfig({ disabledExtensions: [WIDGET_MANAGER_PLUGIN] });
    expect(decideInjection(config, new Set(ANYWIDGET_11)).catalog).toMatchObject({
      'anywidget-0.11': 'unsupported',
      'widget-manager': 'disabled'
    });
  });

  it('lets disabledExtensions win over a native copy', () => {
    const config = pageConfig({
      federated_extensions: [{ name: WEBMCP_PACKAGE, load: 'remoteEntry.js' }],
      disabledExtensions: [WEBMCP_PACKAGE]
    });

    expect(decideInjection(config).webmcp).toBe('disabled');
  });

  it('does not inject a component whose main plugin is disabled', () => {
    const config = pageConfig({
      disabledExtensions: ['jupyterlab-ai-commands:plugin', 'jupyter-webmcp:plugin']
    });
    expect(decideInjection(config)).toMatchObject({ ai: 'disabled', webmcp: 'disabled' });
  });
});

describe('injectRuntime', () => {
  it('adds the runtime entry and the decision the runtime reads', () => {
    const config = pageConfig();
    const result = injectRuntime(config, decideInjection(config), LOAD, BUILDS);

    expect(result.federated_extensions.at(-1)).toEqual({
      name: RUNTIME_PACKAGE,
      load: LOAD,
      extension: './extension'
    });
    expect(result[RUNTIME_CONFIG_KEY]).toEqual({ ai: true, webmcp: true, catalog: [] });
  });

  it('adds the selected catalog entries and their flags', () => {
    const config = pageConfig();
    const decision = decideInjection(config, new Set(ANYWIDGET_11));
    const result = injectRuntime(config, decision, LOAD, BUILDS);

    expect(result.federated_extensions.slice(-2)).toEqual([
      {
        name: catalogEntry('widget-manager')!.federation,
        load: BUILDS['widget-manager'].load,
        extension: BUILDS['widget-manager'].extension
      },
      {
        name: catalogEntry('anywidget-0.11')!.federation,
        load: BUILDS['anywidget-0.11'].load,
        extension: BUILDS['anywidget-0.11'].extension
      }
    ]);
    expect(result[RUNTIME_CONFIG_KEY]).toEqual({
      ai: true,
      webmcp: true,
      catalog: [
        { id: 'widget-manager', plugin: WIDGET_MANAGER_PLUGIN },
        { id: 'anywidget-0.11', plugin: catalogEntry('anywidget-0.11')!.plugin }
      ]
    });
  });

  it('is idempotent on a second read', () => {
    const config = pageConfig();
    const once = injectRuntime(config, decideInjection(config), LOAD, BUILDS);
    const twice = injectRuntime(once, decideInjection(once), LOAD, BUILDS);
    expect(twice).toBe(once);
  });

  it('returns the configuration unchanged when nothing is injected', () => {
    const config = pageConfig({
      federated_extensions: [
        { name: AI_COMMANDS_PACKAGE, load: 'remoteEntry.js' },
        { name: WEBMCP_PACKAGE, load: 'remoteEntry.js' }
      ]
    });
    expect(injectRuntime(config, decideInjection(config), LOAD, BUILDS)).toBe(config);
  });
});

describe('selectionFor', () => {
  it('selects the default extensions when the instance has no saved record', () => {
    expect([...selectionFor(null, 'http://localhost:8888/')]).toEqual(['anywidget-0.11']);
    expect([...selectionFor('not json', 'http://localhost:8888/')]).toEqual(['anywidget-0.11']);
  });

  it('returns the ids written for the same Jupyter instance', () => {
    const raw = serializeSelection('http://localhost:8888/', ['anywidget-0.10', 'anywidget-0.10']);
    expect([...selectionFor(raw, 'http://localhost:8888/')]).toEqual(['anywidget-0.10']);
  });

  it('applies the default, not another instance record', () => {
    const raw = serializeSelection('http://localhost:8888/', ['anywidget-0.10']);
    expect([...selectionFor(raw, 'http://localhost:9999/')]).toEqual(['anywidget-0.11']);
  });

  it('treats a record with no ids as an opt-out', () => {
    const raw = serializeSelection('http://localhost:8888/', []);
    expect(selectionFor(raw, 'http://localhost:8888/').size).toBe(0);
  });
});
