/**
 * The injected AI commands plugin: the upstream commands without the settings
 * load, which needs a schema that the runtime does not ship.
 */

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IEditorTracker } from '@jupyterlab/fileeditor';
import { INotebookTracker } from '@jupyterlab/notebook';
import { registerFileCommands } from './vendor/jupyterlab-ai-commands/src/file-commands';
import { registerKernelCommands } from './vendor/jupyterlab-ai-commands/src/kernel-commands';
import { registerNotebookCommands } from './vendor/jupyterlab-ai-commands/src/notebook-commands';
import { reportStatus } from './status';

/** The id of the AI commands plugin, as in the upstream extension. */
export const AI_PLUGIN_ID = 'jupyterlab-ai-commands:plugin';

/** The prefix of the commands that the upstream extension registers. */
export const AI_COMMAND_PREFIX = 'jupyterlab-ai-commands:';

const plugin: JupyterFrontEndPlugin<void> = {
  id: AI_PLUGIN_ID,
  description: 'A set of commands for AI in JupyterLab (injected by the browser extension)',
  autoStart: true,
  requires: [IDocumentManager],
  optional: [IEditorTracker, INotebookTracker],
  activate: (
    app: JupyterFrontEnd,
    docManager: IDocumentManager,
    editorTracker: IEditorTracker | null,
    notebookTracker: INotebookTracker | null
  ) => {
    const { commands, serviceManager } = app;
    const existing = commands
      .listCommands()
      .filter(id => id.startsWith(AI_COMMAND_PREFIX));
    if (existing.length > 0) {
      reportStatus('ai', 'failed', `commands already registered: ${existing[0]}`);
      return;
    }
    try {
      registerFileCommands({
        commands,
        docManager,
        editorTracker: editorTracker ?? undefined,
        serviceManager
      });
      registerNotebookCommands({
        commands,
        docManager,
        serviceManager,
        notebookTracker: notebookTracker ?? undefined
      });
      registerKernelCommands({
        commands,
        kernelManager: serviceManager.kernels,
        kernelSpecManager: serviceManager.kernelspecs
      });
      reportStatus('ai', 'active');
    } catch (error) {
      reportStatus('ai', 'failed', String(error));
      throw error;
    }
  }
};

export default plugin;
