/**
 * Runtime packages: labextensions from PyPI wheels, verified by sha256 before
 * they are stored. The service worker stores the files, the isolated bridge
 * turns them into blob URLs, and the page hook injects them.
 *
 * This module is pure. It holds the shapes the three contexts exchange and the
 * conversions between them.
 */

import { isPackageId } from './pypi';
import { isRecord } from './config';

/** The sessionStorage key prefix recording a verified package the page blocked. */
export const BLOCKED_KEY_PREFIX = 'jwe-runtime-blocked:';

/**
 * The localStorage key of an origin's last verified payloads. The bridge writes
 * it, and the page hook reads it synchronously before the bridge's reply arrives.
 */
export const RUNTIME_CACHE_KEY = 'jwe-runtime-artifacts';

/** A verified package as the page receives it: blob URLs of its files, by path. */
export interface IRuntimeArtifact {
  version: string;
  /** The federation container name. */
  federation: string;
  load: string;
  extension: string;
  urls: Record<string, string>;
}

/** A verified package as the bridge receives it from the service worker. */
export interface IRuntimeArtifactPayload {
  version: string;
  federation: string;
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

/** The file path of a load value, which is written as `./static/...`. */
export function filePathOf(load: string): string {
  return load.replace(/^\.\//, '');
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
 * The verified payloads by package id, from a service worker reply or a cached
 * value. Entries that are not well formed are dropped.
 */
export function payloadsFrom(value: unknown): Record<string, IRuntimeArtifactPayload> {
  const payloads: Record<string, IRuntimeArtifactPayload> = {};
  if (!isRecord(value)) {
    return payloads;
  }
  for (const [id, entry] of Object.entries(value)) {
    if (!isPackageId(id) || !isRecord(entry) || !isRecord(entry.files)) {
      continue;
    }
    const { version, federation, load, extension, files } = entry;
    if (
      typeof version !== 'string' ||
      typeof federation !== 'string' ||
      typeof load !== 'string' ||
      typeof extension !== 'string'
    ) {
      continue;
    }
    const bytes = Object.fromEntries(
      Object.entries(files).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string'
      )
    );
    payloads[id] = { version, federation, load, extension, files: bytes };
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
    artifacts[id] = {
      version: payload.version,
      federation: payload.federation,
      load: payload.load,
      extension: payload.extension,
      urls
    };
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
    if (!isPackageId(id) || !isRecord(value) || !isRecord(value.urls)) {
      continue;
    }
    const { version, federation, load, extension, urls } = value;
    if (
      typeof version !== 'string' ||
      typeof federation !== 'string' ||
      typeof load !== 'string' ||
      typeof extension !== 'string'
    ) {
      continue;
    }
    const blobs = Object.fromEntries(
      Object.entries(urls).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].startsWith('blob:')
      )
    );
    artifacts[id] = { version, federation, load, extension, urls: blobs };
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
