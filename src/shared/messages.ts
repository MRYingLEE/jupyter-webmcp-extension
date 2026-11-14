/**
 * Extension messages between the content bridge, the service worker, and the
 * popup or options pages.
 */

import type { IRuntimeStatus } from '../../runtime/src/channel';

/** Status reported by the bridge for the tab that sent it. */
export interface IStatusMessage {
  type: 'status';
  status: IRuntimeStatus;
}

/** Enable the extension for an origin the user granted permission to. */
export interface IEnableMessage {
  type: 'enable';
  origin: string;
}

/** Disable the extension for an origin. */
export interface IDisableMessage {
  type: 'disable';
  origin: string;
}

/** Ask for the enablement and status of a tab's origin. */
export interface IStateMessage {
  type: 'state';
  tabId: number;
  origin: string;
}

/** The status of one tab, kept by the service worker. */
export interface ITabStatus {
  origin: string;
  /** The document that reported the status, so a new page does not inherit old components. */
  documentId?: string;
  components: Partial<Record<IRuntimeStatus['component'], Omit<IRuntimeStatus, 'component'>>>;
  updated: number;
}

/** The answer to a `state` message. */
export interface IStateResponse {
  enabled: boolean;
  status?: ITabStatus;
  /** Statuses of embedded frames in the tab, from any origin. */
  embedded: IEmbeddedStatus[];
}

/** The status of an embedded frame, keyed by its frame id within the tab. */
export interface IEmbeddedStatus extends ITabStatus {
  frameId: number;
}

/** Messages handled by the service worker. */
export type ExtensionMessage =
  | IStatusMessage
  | IEnableMessage
  | IDisableMessage
  | IStateMessage;
