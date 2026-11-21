/**
 * The per-tab catalog selection, kept in the page's sessionStorage.
 *
 * The popup writes it and the page hook reads it synchronously, before
 * JupyterLab reads the configuration. The record names the Jupyter instance it
 * was written for, so another instance in the same tab ignores it.
 */

import { isRecord } from './config';
import { DEFAULT_SELECTION } from './catalog';

/** The sessionStorage key holding the selection record. */
export const SELECTION_KEY = 'jupyter-webmcp-extension:catalog-selection';

/** Serialize the selected catalog ids for one Jupyter instance. */
export function serializeSelection(
  baseUrl: string,
  ids: readonly string[]
): string {
  return JSON.stringify({ baseUrl, ids: [...new Set(ids)] });
}

/**
 * The selected catalog ids for a Jupyter instance.
 *
 * Without a record for this instance (missing, malformed, or written for
 * another instance) the default selection applies. A record with no ids is an
 * explicit opt-out.
 */
export function selectionFor(
  raw: string | null,
  baseUrl: string | undefined
): Set<string> {
  const fallback = new Set(DEFAULT_SELECTION);
  if (raw === null || baseUrl === undefined) {
    return fallback;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!isRecord(data) || data.baseUrl !== baseUrl || !Array.isArray(data.ids)) {
    return fallback;
  }
  return new Set(
    data.ids.filter((id): id is string => typeof id === 'string')
  );
}
