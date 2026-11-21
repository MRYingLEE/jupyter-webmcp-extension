/**
 * MAIN-world entry, run at `document_start` on enabled origins.
 */

import { installPageHook } from './bootstrap-main';
import { CatalogBuilds } from '../shared/catalog';

declare const __RUNTIME_LOAD__: string;
declare const __CATALOG_BUILDS__: CatalogBuilds;

installPageHook(window, __RUNTIME_LOAD__, __CATALOG_BUILDS__);
