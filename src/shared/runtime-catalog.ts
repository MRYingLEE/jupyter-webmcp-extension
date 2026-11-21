/**
 * The runtime catalog: catalog builds fetched from a remote manifest, verified
 * by sha256, and used in place of the bundled builds when they are present.
 *
 * This module is pure. The service worker fetches and stores the files, the
 * isolated bridge turns them into blob URLs, and the page hook chooses between
 * them and the bundled builds. The manifest can only supply bytes and versions
 * for catalog ids that the pins already name.
 */

import { CATALOG_IDS, CatalogBuilds, catalogEntry } from './catalog';
import { isRecord } from './config';

/** The schema identifier every manifest must carry. */
export const RUNTIME_MANIFEST_SCHEMA = 'jupyter-webmcp-extension/runtime-catalog@1';

/** The sessionStorage key prefix recording a verified build the page blocked. */
export const BLOCKED_KEY_PREFIX = 'jwe-runtime-blocked:';

/**
 * The localStorage key of an origin's last verified payloads. The bridge writes
 * it, and the page hook reads it synchronously before the bridge's reply arrives.
 */
export const RUNTIME_CACHE_KEY = 'jwe-runtime-artifacts';

/** One file of a runtime entry, relative to the entry's base URL. */
export interface IRuntimeFile {
  path: string;
  sha256: string;
}

/** One catalog build in a manifest. */
export interface IRuntimeEntry {
  id: string;
  federation: string;
  version: string;
  /** The directory of the entry's files, relative to the manifest URL. */
  base: string;
  /** The remote entry, as `./static/...`. Its file path is listed in `files`. */
  load: string;
  extension: string;
  files: IRuntimeFile[];
}

/** A runtime catalog manifest, as fetched and validated. */
export interface IRuntimeManifest {
  schema: string;
  entries: IRuntimeEntry[];
}

/** A verified entry as the page receives it: blob URLs of its files, by path. */
export interface IRuntimeArtifact {
  version: string;
  load: string;
  extension: string;
  urls: Record<string, string>;
}

/** A verified entry as the bridge receives it from the service worker. */
export interface IRuntimeArtifactPayload {
  version: string;
  load: string;
  extension: string;
  /** The file bytes, base64-encoded, by path. */
  files: Record<string, string>;
}

/** How the page provides a catalog entry, as the page hook reports it to the popup. */
export interface ICatalogSource {
  source: 'runtime' | 'bundled' | 'blocked';
  version?: string;
}

/**
 * Whether a relative path stays inside its directory: no leading slash, no
 * backslash, no scheme or query, and no empty, `.`, or `..` segment.
 */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || /[\\?#:]/.test(path)) {
    return false;
  }
  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

/** The file path of a load value, which is written as `./static/...`. */
export function filePathOf(load: string): string {
  return load.replace(/^\.\//, '');
}

/**
 * Parse and validate a manifest. Any invalid entry rejects the whole manifest,
 * so a refresh never mixes a valid part with a rejected one.
 *
 * @throws Error with a message that names the first problem found.
 */
export function parseRuntimeManifest(text: string, manifestUrl: string): IRuntimeManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The manifest is not valid JSON.');
  }
  if (!isRecord(data) || data.schema !== RUNTIME_MANIFEST_SCHEMA) {
    throw new Error(`The manifest schema must be ${RUNTIME_MANIFEST_SCHEMA}.`);
  }
  if (!Array.isArray(data.entries)) {
    throw new Error('The manifest entries must be an array.');
  }
  const seen = new Set<string>();
  const entries = data.entries.map(raw => {
    const entry = parseEntry(raw, manifestUrl);
    if (seen.has(entry.id)) {
      throw new Error(`The manifest lists ${entry.id} twice.`);
    }
    seen.add(entry.id);
    return entry;
  });
  return { schema: RUNTIME_MANIFEST_SCHEMA, entries };
}

function parseEntry(raw: unknown, manifestUrl: string): IRuntimeEntry {
  if (!isRecord(raw)) {
    throw new Error('Each manifest entry must be an object.');
  }
  const { id, federation, version, base, load, extension, files } = raw;
  if (typeof id !== 'string' || !CATALOG_IDS.has(id)) {
    throw new Error(`Unknown catalog id ${String(id)}.`);
  }
  const pinned = catalogEntry(id);
  if (typeof federation !== 'string' || federation !== pinned?.federation) {
    throw new Error(`${id}: the federation name must be ${pinned?.federation}.`);
  }
  if (typeof version !== 'string' || !/^[0-9A-Za-z._+-]{1,64}$/.test(version)) {
    throw new Error(`${id}: the version is missing or malformed.`);
  }
  if (typeof base !== 'string' || !base.endsWith('/') || !isSafeRelativePath(base.slice(0, -1))) {
    throw new Error(`${id}: the base must be a relative directory inside the manifest's directory.`);
  }
  // The base is relative and has no scheme, so it stays on the manifest's origin.
  new URL(base, manifestUrl);
  if (typeof load !== 'string' || !load.startsWith('./')) {
    throw new Error(`${id}: the load must start with ./.`);
  }
  if (typeof extension !== 'string' || !extension.startsWith('./') || !isSafeRelativePath(extension.slice(2))) {
    throw new Error(`${id}: the extension must be a module path starting with ./.`);
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`${id}: the files must be a non-empty array.`);
  }
  const parsed = files.map(file => parseFile(id, file));
  const paths = new Set(parsed.map(file => file.path));
  if (paths.size !== parsed.length) {
    throw new Error(`${id}: a file is listed twice.`);
  }
  if (!paths.has(filePathOf(load))) {
    throw new Error(`${id}: the load ${load} is not in the files.`);
  }
  return { id, federation, version, base, load, extension, files: parsed };
}

function parseFile(id: string, raw: unknown): IRuntimeFile {
  if (!isRecord(raw)) {
    throw new Error(`${id}: each file must be an object.`);
  }
  const { path, sha256 } = raw;
  if (typeof path !== 'string' || !isSafeRelativePath(path)) {
    throw new Error(`${id}: the file path ${String(path)} is not a safe relative path.`);
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`${id}: the sha256 of ${path} must be 64 lowercase hex digits.`);
  }
  return { path, sha256 };
}

/** The sha256 of some bytes, as lowercase hex. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Base64-encode bytes, in chunks so that large files do not exceed the call stack. */
export function encodeBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Decode base64 into bytes. */
export function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), char => char.charCodeAt(0));
}

/**
 * The verified payloads by catalog id, from a service worker reply or a cached
 * value. Entries that are not well formed are dropped.
 */
export function payloadsFrom(value: unknown): Record<string, IRuntimeArtifactPayload> {
  const payloads: Record<string, IRuntimeArtifactPayload> = {};
  if (!isRecord(value)) {
    return payloads;
  }
  for (const [id, entry] of Object.entries(value)) {
    if (!CATALOG_IDS.has(id) || !isRecord(entry) || !isRecord(entry.files)) {
      continue;
    }
    const { version, load, extension, files } = entry;
    if (typeof version !== 'string' || typeof load !== 'string' || typeof extension !== 'string') {
      continue;
    }
    const bytes = Object.fromEntries(
      Object.entries(files).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string'
      )
    );
    payloads[id] = { version, load, extension, files: bytes };
  }
  return payloads;
}

/**
 * The page-side artifacts for verified payloads: each file as a blob URL of
 * the current document's origin, by path. Throws when a file is not valid base64.
 */
export function blobArtifacts(
  payloads: Record<string, IRuntimeArtifactPayload>
): Record<string, IRuntimeArtifact> {
  const artifacts: Record<string, IRuntimeArtifact> = {};
  for (const [id, payload] of Object.entries(payloads)) {
    const urls: Record<string, string> = {};
    for (const [path, base64] of Object.entries(payload.files)) {
      const type = path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      urls[path] = URL.createObjectURL(new Blob([decodeBase64(base64)], { type }));
    }
    artifacts[id] = { version: payload.version, load: payload.load, extension: payload.extension, urls };
  }
  return artifacts;
}

/**
 * Parse the artifact table the bridge writes to the page, or return an empty
 * table when the attribute is missing or malformed.
 */
export function parseArtifacts(text: string | null): Record<string, IRuntimeArtifact> {
  if (text === null) {
    return {};
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(data)) {
    return {};
  }
  const artifacts: Record<string, IRuntimeArtifact> = {};
  for (const [id, value] of Object.entries(data)) {
    if (!CATALOG_IDS.has(id) || !isRecord(value) || !isRecord(value.urls)) {
      continue;
    }
    const { version, load, extension, urls } = value;
    if (typeof version !== 'string' || typeof load !== 'string' || typeof extension !== 'string') {
      continue;
    }
    const blobs = Object.fromEntries(
      Object.entries(urls).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].startsWith('blob:')
      )
    );
    artifacts[id] = { version, load, extension, urls: blobs };
  }
  return artifacts;
}

/**
 * The artifacts the page may use: those whose version the page did not block,
 * and whose remote entry is present.
 */
export function usableArtifacts(
  artifacts: Record<string, IRuntimeArtifact>,
  blocked: Record<string, string>
): Record<string, IRuntimeArtifact> {
  const usable: Record<string, IRuntimeArtifact> = {};
  for (const [id, artifact] of Object.entries(artifacts)) {
    if (blocked[id] === artifact.version || !artifact.urls[filePathOf(artifact.load)]) {
      continue;
    }
    usable[id] = artifact;
  }
  return usable;
}

/** The bundled builds, with each usable artifact's load and module in place of the bundled one. */
export function mergeBuilds(
  bundled: CatalogBuilds,
  usable: Record<string, IRuntimeArtifact>
): CatalogBuilds {
  const merged: CatalogBuilds = { ...bundled };
  for (const [id, artifact] of Object.entries(usable)) {
    merged[id] = { load: artifact.load, extension: artifact.extension };
  }
  return merged;
}
