/**
 * Reports the outcome of the injected components to the isolated bridge.
 */

import { IRuntimeStatus, RuntimeComponent, RuntimeState, STATUS_EVENT } from './channel';

export function reportStatus(
  component: RuntimeComponent,
  state: RuntimeState,
  detail?: string
): void {
  const status: IRuntimeStatus =
    detail === undefined ? { component, state } : { component, state, detail };
  if (state === 'failed') {
    console.warn(`[jupyter-webmcp-extension] ${component} failed: ${detail}`);
  }
  document.dispatchEvent(
    new CustomEvent(STATUS_EVENT, { detail: JSON.stringify(status) })
  );
}
