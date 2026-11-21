/**
 * The per-tab catalog selection, kept in the page's sessionStorage.
 *
 * The popup writes it and the page hook reads it synchronously, before
 * JupyterLab reads the configuration. The record names the Jupyter instance it
 * was written for, so another instance in the same tab ignores it.
 */

import { isRecord } from './config';
import { CATALOG_EXTENSIONS, DEFAULT_SELECTION } from './catalog';

/** The sessionStorage key holding the selection record. */
export const SELECTION_KEY = 'jupyter-webmcp-extension:catalog-selection';

/** Serialize the on or off state of each extension id for one Jupyter instance. */
export function serializeSelection(
  baseUrl: string,
  states: Readonly<Record<string, boolean>>
): string {
  return JSON.stringify({ baseUrl, states });
}

/** The saved on or off states for a Jupyter instance, or null without a usable record. */
function savedStates(
  raw: string | null,
  baseUrl: string | undefined
): Map<string, boolean> | null {
  if (raw === null || baseUrl === undefined) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.baseUrl !== baseUrl || !isRecord(data.states)) {
    return null;
  }
  const states = new Map<string, boolean>();
  for (const [id, on] of Object.entries(data.states)) {
    if (typeof on === 'boolean') {
      states.set(id, on);
    }
  }
  return states;
}

/**
 * The selected extension ids for a Jupyter instance.
 *
 * Each catalog extension starts as its catalog default, and each id in
 * `packageIds` starts selected. The saved record for this instance overrides
 * either default. A record written for another instance, or a malformed one,
 * is ignored.
 */
export function selectionFor(
  raw: string | null,
  baseUrl: string | undefined,
  packageIds: readonly string[]
): Set<string> {
  const defaults = new Map<string, boolean>(
    CATALOG_EXTENSIONS.map(entry => [
      entry.id,
      DEFAULT_SELECTION.includes(entry.id)
    ])
  );
  for (const id of packageIds) {
    defaults.set(id, true);
  }
  const states = savedStates(raw, baseUrl) ?? new Map<string, boolean>();
  const selected = new Set<string>();
  for (const [id, on] of defaults) {
    if (states.get(id) ?? on) {
      selected.add(id);
    }
  }
  return selected;
}
