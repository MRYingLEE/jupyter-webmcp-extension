/**
 * The injected WebMCP plugins: the tool registry and the status bar item.
 *
 * They mirror the upstream plugin, except that the settings come from the
 * bridge (see `RuntimeSettings`), and that the kernel commands are added only
 * when their ids are free.
 */

import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Dialog, ICommandPalette, showDialog } from '@jupyterlab/apputils';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { IStatusBar } from '@jupyterlab/statusbar';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { CommandIDs, LOG_PREFIX, PLUGIN_ID } from './vendor/jupyter-webmcp/src/commands';
import { KernelCommands } from './vendor/jupyter-webmcp/src/kernels';
import { ToolManager } from './vendor/jupyter-webmcp/src/manager';
import { getModelContext } from './vendor/jupyter-webmcp/src/modelcontext';
import { WebMCPRegistry } from './vendor/jupyter-webmcp/src/registry';
import { IWebMCPRegistry } from './vendor/jupyter-webmcp/src/tokens';
import {
  ToolList,
  WebMCPStatus,
  unavailableHint
} from './vendor/jupyter-webmcp/src/widgets';
import { asRegistrySettings, RuntimeSettings } from './settings';
import { reportStatus } from './status';

/** The translation domain of the upstream extension. */
const DOMAIN = 'jupyter_webmcp';

const plugin: JupyterFrontEndPlugin<IWebMCPRegistry> = {
  id: PLUGIN_ID,
  description:
    'Provides the WebMCP tool registry (injected by the browser extension).',
  autoStart: true,
  provides: IWebMCPRegistry,
  optional: [ICommandPalette, ITranslator, IDefaultFileBrowser, ILabShell],
  activate: (
    app: JupyterFrontEnd,
    palette: ICommandPalette | null,
    translator: ITranslator | null,
    fileBrowser: IDefaultFileBrowser | null,
    labShell: ILabShell | null
  ): IWebMCPRegistry => {
    const trans = (translator ?? nullTranslator).load(DOMAIN);
    const modelContext = getModelContext();
    const registry = new WebMCPRegistry(modelContext);
    const manager = new ToolManager({
      app,
      registry,
      trans,
      fileBrowser,
      labShell
    });

    if (!app.commands.hasCommand(CommandIDs.interruptKernel) &&
        !app.commands.hasCommand(CommandIDs.restartKernel)) {
      KernelCommands.addCommands(app, trans);
    }

    app.commands.addCommand(CommandIDs.showTools, {
      label: trans.__('Show WebMCP Tools'),
      caption: trans.__('List the WebMCP tools of this page'),
      describedBy: { args: { type: 'object', properties: {} } },
      execute: () =>
        showDialog({
          title: trans.__('WebMCP Tools'),
          body: new ToolList({ registry, manager, trans }),
          buttons: [Dialog.cancelButton({ label: trans.__('Close') })]
        })
    });
    palette?.addItem({
      command: CommandIDs.showTools,
      category: trans.__('WebMCP')
    });

    if (!modelContext) {
      const hint = unavailableHint(nullTranslator.load(DOMAIN));
      console.debug(`${LOG_PREFIX} ${hint}`);
      reportStatus('webmcp', 'failed', hint);
      return registry;
    }

    app.restored
      .then(() => RuntimeSettings.load())
      .then(settings => {
        settings.listen();
        const reportToolCount = (): void => {
          reportStatus(
            'webmcp',
            'active',
            trans._n(
              '%1 WebMCP tool available',
              '%1 WebMCP tools available',
              registry.toolNames.length
            )
          );
        };
        registry.changed.connect(reportToolCount);
        manager.start(asRegistrySettings(settings));
        reportToolCount();
      })
      .catch(reason => {
        console.error(`${LOG_PREFIX} The tools could not be started:`, reason);
        manager.fail(reason);
        reportStatus('webmcp', 'failed', String(reason));
      });

    return registry;
  }
};

const status: JupyterFrontEndPlugin<void> = {
  id: 'jupyter-webmcp:status',
  description: 'Adds a status bar item with the number of WebMCP tools.',
  autoStart: true,
  requires: [IWebMCPRegistry],
  optional: [IStatusBar, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    registry: IWebMCPRegistry,
    statusBar: IStatusBar | null,
    translator: ITranslator | null
  ): void => {
    if (!statusBar) {
      return;
    }
    const trans = (translator ?? nullTranslator).load(DOMAIN);
    statusBar.registerStatusItem(status.id, {
      item: new WebMCPStatus({ registry, commands: app.commands, trans }),
      align: 'left',
      rank: 5
    });
  }
};

export default [plugin, status];
