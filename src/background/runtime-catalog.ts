/**
 * The service worker's runtime package store. Each loaded package's labextension
 * files live in IndexedDB under `<id>/<path>`; its name, version, federation
 * name, and file list live in `chrome.storage.local`.
 *
 * A load is all-or-nothing: the wheel is checked against the sha256 PyPI
 * publishes before anything is stored, and the package's files are replaced in
 * one transaction. Every operation goes through one queue, so a payload never
 * mixes the files of two loads.
 */

import type { IRuntimeCatalogState } from '../shared/messages';
import { IRuntimeArtifactPayload, encodeBase64, sha256Hex } from '../shared/runtime-catalog';
import {
  PYPI_ORIGINS,
  findLabextension,
  isPackageId,
  packageId,
  packageRequest,
  pypiReleaseUrl,
  selectWheel
} from '../shared/pypi';
import { readZip } from '../shared/zip';
import { isRecord } from '../shared/config';
import { originPattern } from '../shared/origin';
import { RUNTIME_CATALOG_KEY } from '../shared/storage';

const DB_NAME = 'jwe-runtime-catalog';
const STORE = 'files';

interface IStoredPackage {
  name: string;
  version: string;
  federation: string;
  load: string;
  extension: string;
  paths: string[];
  fetchedAt: number;
}

interface IStoredCatalog {
  packages: Record<string, IStoredPackage>;
}

let queue: Promise<unknown> = Promise.resolve();

/** Run a task after every earlier task has settled. */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.catch(() => undefined);
  return result;
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

function requestDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('The transaction was aborted.'));
  });
}

function fileKey(id: string, path: string): string {
  return `${id}/${path}`;
}

async function fetchBytes(url: URL): Promise<ArrayBuffer> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}.`);
  }
  return response.arrayBuffer();
}

/** Delete every stored file of a package, within an open transaction. */
function deletePackageFiles(store: IDBObjectStore, id: string): void {
  const prefix = `${id}/`;
  store.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
}

/** The PyPI hosts that a load reads, which the optional host permission must cover. */
async function requirePypiPermission(): Promise<void> {
  const origins = PYPI_ORIGINS.map(origin => originPattern(origin));
  if (!(await chrome.permissions.contains({ origins }))) {
    throw new Error('Permission to read pypi.org and files.pythonhosted.org is not granted.');
  }
}

async function readStored(): Promise<IStoredCatalog> {
  const stored: unknown = (await chrome.storage.local.get(RUNTIME_CATALOG_KEY))[RUNTIME_CATALOG_KEY];
  if (!isRecord(stored) || !isRecord(stored.packages)) {
    return { packages: {} };
  }
  return stored as unknown as IStoredCatalog;
}

function stateOf(stored: IStoredCatalog): IRuntimeCatalogState {
  return {
    packages: Object.entries(stored.packages).map(([id, pkg]) => ({
      id,
      name: pkg.name,
      version: pkg.version,
      federation: pkg.federation,
      fetchedAt: pkg.fetchedAt
    }))
  };
}

/**
 * Download a package's universal wheel from PyPI, verify it against the sha256
 * PyPI publishes, and store its labextension in place of any earlier copy of
 * the same package. On any failure the stored package is kept.
 *
 * @throws Error when the name, the version, the permission, the download, or the wheel is not acceptable.
 */
export function loadRuntimePackage(name: string, version: string): Promise<IRuntimeCatalogState> {
  return serialize(async () => {
    const request = packageRequest(name, version);
    const id = packageId(request.name);
    await requirePypiPermission();

    const metadata: unknown = JSON.parse(
      new TextDecoder().decode(await fetchBytes(new URL(pypiReleaseUrl(request.name, request.version))))
    );
    const wheel = selectWheel(metadata);
    const wheelUrl = new URL(wheel.url);
    if (!PYPI_ORIGINS.includes(wheelUrl.origin)) {
      throw new Error(`${wheel.filename} is served from ${wheelUrl.origin}, not PyPI.`);
    }
    const bytes = await fetchBytes(wheelUrl);
    if ((await sha256Hex(bytes)) !== wheel.sha256) {
      throw new Error(`${wheel.filename} does not match its sha256 on PyPI.`);
    }
    const labextension = findLabextension(await readZip(new Uint8Array(bytes)));

    const database = await openDatabase();
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    deletePackageFiles(store, id);
    for (const [path, content] of labextension.files) {
      store.put(content.slice().buffer as ArrayBuffer, fileKey(id, path));
    }
    await transactionDone(transaction);

    const stored = await readStored();
    stored.packages[id] = {
      name: request.name,
      version: request.version,
      federation: labextension.federation,
      load: labextension.load,
      extension: labextension.extension,
      paths: [...labextension.files.keys()],
      fetchedAt: Date.now()
    };
    await chrome.storage.local.set({ [RUNTIME_CATALOG_KEY]: stored });
    return stateOf(stored);
  });
}

/** Remove a loaded package and its files. */
export function unloadRuntimePackage(id: string): Promise<IRuntimeCatalogState> {
  return serialize(async () => {
    if (!isPackageId(id)) {
      throw new Error('Only runtime packages can be unloaded.');
    }
    const database = await openDatabase();
    const transaction = database.transaction(STORE, 'readwrite');
    deletePackageFiles(transaction.objectStore(STORE), id);
    await transactionDone(transaction);

    const stored = await readStored();
    delete stored.packages[id];
    await chrome.storage.local.set({ [RUNTIME_CATALOG_KEY]: stored });
    return stateOf(stored);
  });
}

/** The loaded packages, with their names, versions, and federation names. */
export function runtimeCatalogState(): Promise<IRuntimeCatalogState> {
  return serialize(async () => stateOf(await readStored()));
}

/**
 * The verified bytes of every complete package, base64-encoded by path. A
 * package with a missing file is left out.
 */
export function runtimeArtifactPayloads(): Promise<Record<string, IRuntimeArtifactPayload>> {
  return serialize(async () => {
    const stored = await readStored();
    const database = await openDatabase();
    const store = database.transaction(STORE, 'readonly').objectStore(STORE);
    const reads = Object.entries(stored.packages).map(([id, pkg]) => ({
      id,
      pkg,
      files: pkg.paths.map(path => requestDone<ArrayBuffer | undefined>(store.get(fileKey(id, path))))
    }));

    const payloads: Record<string, IRuntimeArtifactPayload> = {};
    for (const { id, pkg, files } of reads) {
      const bytes = await Promise.all(files);
      if (bytes.some(item => !(item instanceof ArrayBuffer))) {
        continue;
      }
      payloads[id] = {
        version: pkg.version,
        federation: pkg.federation,
        load: pkg.load,
        extension: pkg.extension,
        files: Object.fromEntries(
          pkg.paths.map((path, index) => [path, encodeBase64(bytes[index] as ArrayBuffer)])
        )
      };
    }
    return payloads;
  });
}
