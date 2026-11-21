/**
 * Reports whether each runtime-injected catalog extension started.
 *
 * A federated remote that fails to load never registers its plugin, so the
 * plugin's absence after the application has restored is reported as a failure.
 */

import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICatalogFlag } from './channel';
import { reportStatus } from './status';

export const CATALOG_STATUS_PLUGIN_ID = 'jupyter-webmcp-extension:catalog-status';

export function catalogStatusPlugin(
  catalog: ICatalogFlag[]
): JupyterFrontEndPlugin<void> {
  return {
    id: CATALOG_STATUS_PLUGIN_ID,
    description: 'Reports the status of catalog extensions (injected by the browser extension)',
    autoStart: true,
    activate: (app: JupyterFrontEnd) => {
      void app.restored.then(() => {
        for (const { id, plugin } of catalog) {
          if (!app.hasPlugin(plugin)) {
            reportStatus(id, 'failed', `plugin ${plugin} is not registered`);
          } else if (!app.isPluginActivated(plugin)) {
            reportStatus(id, 'failed', `plugin ${plugin} is not activated`);
          } else {
            reportStatus(id, 'active');
          }
        }
      });
    }
  };
}
