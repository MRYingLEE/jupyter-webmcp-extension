/**
 * MAIN-world entry, run at `document_start` on enabled origins.
 */

import { installPageHook } from './bootstrap-main';

declare const __RUNTIME_LOAD__: string;

installPageHook(window, __RUNTIME_LOAD__);
