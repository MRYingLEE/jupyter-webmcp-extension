/**
 * The service worker's runtime catalog store. The verified files live in
 * IndexedDB; the manifest URL, fetch time, and each entry's version and file
 * list live in `chrome.storage.local`.
 *
 * A refresh is all-or-nothing: every file is fetched and checked against its
 * sha256 before anything is stored, and the files are replaced in one
 * transaction. Every operation goes through one queue, so a payload never mixes
 * the files of two refreshes.
 */

import type { IRuntimeCatalogState } from '../shared/messages';
import {
  IRuntimeArtifactPayload,
  IRuntimeEntry,
  encodeBase64,
  parseRuntimeManifest,
  sha256Hex
} from '../shared/runtime-catalog';
import { isRecord } from '../shared/config';
import { originPattern } from '../shared/origin';
import { RUNTIME_CATALOG_KEY } from '../shared/storage';

const DB_NAME = 'jwe-runtime-catalog';
const STORE = 'files';

interface IStoredEntry {
  version: string;
  load: string;
  extension: string;
  paths: string[];
}

interface IStoredCatalog {
  manifestUrl: string;
  fetchedAt: number;
  entries: Record<string, IStoredEntry>;
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

/** The manifest URL, which must be https, or http on a loopback address for development. */
function manifestSource(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('The manifest URL is not a valid URL.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The manifest URL must use https.');
  }
  return url;
}

async function fetchBytes(url: URL): Promise<ArrayBuffer> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}.`);
  }
  return response.arrayBuffer();
}

/** Fetch every file of an entry and check its sha256. Nothing is stored here. */
async function fetchEntry(
  entry: IRuntimeEntry,
  manifestUrl: URL,
  files: Map<string, ArrayBuffer>
): Promise<IStoredEntry> {
  const base = new URL(entry.base, manifestUrl);
  for (const file of entry.files) {
    const bytes = await fetchBytes(new URL(file.path, base));
    if ((await sha256Hex(bytes)) !== file.sha256) {
      throw new Error(`${entry.id}: ${file.path} does not match its sha256.`);
    }
    files.set(fileKey(entry.id, file.path), bytes);
  }
  return {
    version: entry.version,
    load: entry.load,
    extension: entry.extension,
    paths: entry.files.map(file => file.path)
  };
}

async function readStored(): Promise<IStoredCatalog | undefined> {
  const stored: unknown = (await chrome.storage.local.get(RUNTIME_CATALOG_KEY))[RUNTIME_CATALOG_KEY];
  if (!isRecord(stored) || typeof stored.manifestUrl !== 'string' || !isRecord(stored.entries)) {
    return undefined;
  }
  return stored as unknown as IStoredCatalog;
}

function stateOf(stored: IStoredCatalog | undefined): IRuntimeCatalogState {
  if (!stored) {
    return { versions: {} };
  }
  return {
    manifestUrl: stored.manifestUrl,
    fetchedAt: stored.fetchedAt,
    versions: Object.fromEntries(
      Object.entries(stored.entries).map(([id, entry]) => [id, entry.version])
    )
  };
}

/**
 * Fetch the manifest and every file it lists, verify them, and replace the
 * stored catalog. On any failure the previous catalog is kept.
 *
 * @throws Error when the manifest, a file, or a permission is not acceptable.
 */
export function refreshRuntimeCatalog(manifestUrl: string): Promise<IRuntimeCatalogState> {
  return serialize(async () => {
    const url = manifestSource(manifestUrl);
    if (!(await chrome.permissions.contains({ origins: [originPattern(url.origin)] }))) {
      throw new Error(`Permission to read ${url.origin} is not granted.`);
    }
    const manifest = parseRuntimeManifest(
      new TextDecoder().decode(await fetchBytes(url)),
      url.href
    );
    const files = new Map<string, ArrayBuffer>();
    const entries: Record<string, IStoredEntry> = {};
    for (const entry of manifest.entries) {
      entries[entry.id] = await fetchEntry(entry, url, files);
    }

    const database = await openDatabase();
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    store.clear();
    for (const [key, bytes] of files) {
      store.put(bytes, key);
    }
    await transactionDone(transaction);

    const stored: IStoredCatalog = { manifestUrl: url.href, fetchedAt: Date.now(), entries };
    await chrome.storage.local.set({ [RUNTIME_CATALOG_KEY]: stored });
    return stateOf(stored);
  });
}

/** The stored catalog's manifest, fetch time, and verified versions. */
export function runtimeCatalogState(): Promise<IRuntimeCatalogState> {
  return serialize(async () => stateOf(await readStored()));
}

/**
 * The verified bytes of every complete entry, base64-encoded by path. An entry
 * with a missing file is left out, so the page keeps the bundled build for it.
 */
export function runtimeArtifactPayloads(): Promise<Record<string, IRuntimeArtifactPayload>> {
  return serialize(async () => {
    const stored = await readStored();
    if (!stored) {
      return {};
    }
    const database = await openDatabase();
    const store = database.transaction(STORE, 'readonly').objectStore(STORE);
    const reads = Object.entries(stored.entries).map(([id, entry]) => ({
      id,
      entry,
      files: entry.paths.map(path =>
        requestDone<ArrayBuffer | undefined>(store.get(fileKey(id, path)))
      )
    }));

    const payloads: Record<string, IRuntimeArtifactPayload> = {};
    for (const { id, entry, files } of reads) {
      const bytes = await Promise.all(files);
      if (bytes.some(item => !(item instanceof ArrayBuffer))) {
        continue;
      }
      payloads[id] = {
        version: entry.version,
        load: entry.load,
        extension: entry.extension,
        files: Object.fromEntries(
          entry.paths.map((path, index) => [path, encodeBase64(bytes[index] as ArrayBuffer)])
        )
      };
    }
    return payloads;
  });
}

/** Remove the stored catalog and its files. */
export function clearRuntimeCatalog(): Promise<void> {
  return serialize(async () => {
    const database = await openDatabase();
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).clear();
    await transactionDone(transaction);
    await chrome.storage.local.remove(RUNTIME_CATALOG_KEY);
  });
}
