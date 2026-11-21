/**
 * The federated extension injected into the Jupyter page.
 *
 * The page hook records which components the runtime provides in the page
 * configuration (see `RUNTIME_CONFIG_KEY`). Only those are exported.
 */

import { PageConfig } from '@jupyterlab/coreutils';
import { ICatalogFlag, IRuntimeFlags, RUNTIME_CONFIG_KEY } from './channel';
import aiPlugin from './ai';
import { catalogStatusPlugin } from './catalog-status';
import webmcpPlugins from './webmcp';

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
  const catalog = Array.isArray(flags.catalog)
    ? flags.catalog.filter(
        (entry): entry is ICatalogFlag =>
          typeof entry?.id === 'string' && typeof entry?.plugin === 'string'
      )
    : [];
  return { ai: flags.ai === true, webmcp: flags.webmcp === true, catalog };
}

const flags = readFlags();
const plugins = [
  ...(flags.ai ? [aiPlugin] : []),
  ...(flags.webmcp ? webmcpPlugins : []),
  ...(flags.catalog.length > 0 ? [catalogStatusPlugin(flags.catalog)] : [])
];

export default plugins;
