/**
 * The bundled runtime extension catalog, read from the pins file.
 *
 * `scripts/build-catalog.mjs` builds the artifacts these pins describe. This
 * module only reads the pins, so the page hook, the bridge, the popup, and the
 * runtime all agree on the same ids and plugin names.
 */

import pins from '../../scripts/catalog-pins.json';

/** A catalog entry: a user-selectable extension or a dependency of one. */
export interface ICatalogEntry {
  id: string;
  label: string;
  role: 'extension' | 'dependency';
  federation: string;
  plugin: string;
  line?: string;
  /** Selected for every Jupyter instance that has no saved selection. */
  selectedByDefault?: boolean;
  kernelRequirement?: string;
  /** Native federated extensions that make this entry a conflict. */
  conflicts?: string[];
  /** Catalog ids that must be injected or native for this entry to work. */
  requires: string[];
}

/** The load path and module of a built catalog artifact. */
export interface ICatalogBuild {
  load: string;
  extension: string;
}

/** The built artifacts, by catalog id. Defined at build time. */
export type CatalogBuilds = Record<string, ICatalogBuild>;

export const CATALOG: readonly ICatalogEntry[] = (
  pins as { entries: ICatalogEntry[] }
).entries;

/** The extensions a user can select, in catalog order. */
export const CATALOG_EXTENSIONS: readonly ICatalogEntry[] = CATALOG.filter(
  entry => entry.role === 'extension'
);

/** The extension ids selected when a Jupyter instance has no saved selection. */
export const DEFAULT_SELECTION: readonly string[] = CATALOG_EXTENSIONS.filter(
  entry => entry.selectedByDefault
).map(entry => entry.id);

/** The ids of every catalog entry. */
export const CATALOG_IDS: ReadonlySet<string> = new Set(
  CATALOG.map(entry => entry.id)
);

/** The catalog entry with an id, if any. */
export function catalogEntry(id: string): ICatalogEntry | undefined {
  return CATALOG.find(entry => entry.id === id);
}
