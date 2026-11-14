/**
 * The federated extension injected into the Jupyter page.
 *
 * The page hook records which components the runtime provides in the page
 * configuration (see `RUNTIME_CONFIG_KEY`). Only those are exported.
 */

import { PageConfig } from '@jupyterlab/coreutils';
import { RUNTIME_CONFIG_KEY } from './channel';
import aiPlugin from './ai';
import webmcpPlugins from './webmcp';

interface IRuntimeFlags {
  ai: boolean;
  webmcp: boolean;
}

function readFlags(): IRuntimeFlags {
  const raw: unknown = PageConfig.getOption(RUNTIME_CONFIG_KEY);
  let value: unknown = raw;
  if (typeof raw === 'string' && raw) {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  const flags = (value ?? {}) as Partial<IRuntimeFlags>;
  return { ai: flags.ai === true, webmcp: flags.webmcp === true };
}

const flags = readFlags();
const plugins = [
  ...(flags.ai ? [aiPlugin] : []),
  ...(flags.webmcp ? webmcpPlugins : [])
];

export default plugins;
