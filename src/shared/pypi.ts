/**
 * PyPI packages loaded as runtime extensions.
 *
 * A package is named by its PyPI name and version. Its universal wheel carries
 * the JupyterLab labextension, which loads as a federated extension. The
 * functions here are pure: the service worker fetches the bytes.
 */

import { isRecord } from './config';

/** The PyPI origins a package is read from: the index, and the file host of its wheels. */
export const PYPI_ORIGINS: readonly string[] = [
  'https://pypi.org',
  'https://files.pythonhosted.org'
];

/** The prefix of a package's catalog id, which keeps it apart from the pinned ids. */
export const PACKAGE_ID_PREFIX = 'pypi:';

const NAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VERSION_PATTERN = /^[0-9A-Za-z.!+_-]{1,64}$/;
const LABEXTENSION_PATTERN =
  /^(?:[^/]+\.data\/data\/)?share\/jupyter\/labextensions\/([^/]+)\/package\.json$/;

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

/** The PEP 503 normalized form of a project name. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** The catalog id of a package, which is `pypi:` and its normalized name. */
export function packageId(name: string): string {
  return `${PACKAGE_ID_PREFIX}${normalizeName(name)}`;
}

/** Whether a catalog id names a runtime package rather than a pinned entry. */
export function isPackageId(id: string): boolean {
  return id.startsWith(PACKAGE_ID_PREFIX);
}

/**
 * A validated package request, with the normalized name.
 *
 * @throws Error when the name or the version is not valid.
 */
export function packageRequest(name: string, version: string): { name: string; version: string } {
  const trimmedName = name.trim();
  const trimmedVersion = version.trim();
  if (!NAME_PATTERN.test(trimmedName)) {
    throw new Error('The package name is not a valid PyPI project name.');
  }
  if (!VERSION_PATTERN.test(trimmedVersion)) {
    throw new Error('The version is missing or malformed.');
  }
  return { name: normalizeName(trimmedName), version: trimmedVersion };
}

/** The PyPI JSON API URL of one release. */
export function pypiReleaseUrl(name: string, version: string): string {
  return `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
}

/** A wheel to download, with the sha256 PyPI publishes for it. */
export interface IWheel {
  filename: string;
  url: string;
  sha256: string;
}

/**
 * The universal wheel of a release, from its PyPI JSON metadata.
 *
 * @throws Error when the release has no universal wheel or the metadata lacks a sha256.
 */
export function selectWheel(metadata: unknown): IWheel {
  if (!isRecord(metadata) || !Array.isArray(metadata.urls)) {
    throw new Error('The PyPI metadata has no file list.');
  }
  const file = metadata.urls.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) &&
      candidate.packagetype === 'bdist_wheel' &&
      typeof candidate.filename === 'string' &&
      candidate.filename.endsWith('-none-any.whl')
  );
  if (!file) {
    throw new Error('This release has no universal wheel (py3-none-any).');
  }
  const { filename, url, digests } = file;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error(`${String(filename)} has no https download URL.`);
  }
  const sha256 = isRecord(digests) ? digests.sha256 : undefined;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`${String(filename)} has no sha256 in the PyPI metadata.`);
  }
  return { filename: String(filename), url, sha256 };
}

/** The labextension of a wheel, ready to store and load. */
export interface ILabextension {
  /** The federation container name, which the remote entry registers on `_JUPYTERLAB`. */
  federation: string;
  /** The remote entry, as `./static/...`. */
  load: string;
  /** The exposed module that provides the plugins, as `./...`. */
  extension: string;
  /** The files of the labextension, by path relative to its directory. */
  files: Map<string, Uint8Array>;
}

/**
 * The single labextension in a wheel's files, read from its `package.json`.
 *
 * @throws Error when the wheel has no labextension, more than one, or an invalid manifest.
 */
export function findLabextension(archive: Map<string, Uint8Array>): ILabextension {
  const manifests = [...archive.keys()].filter(path => LABEXTENSION_PATTERN.test(path));
  if (manifests.length === 0) {
    throw new Error('The wheel has no JupyterLab extension.');
  }
  if (manifests.length > 1) {
    throw new Error('The wheel has more than one JupyterLab extension.');
  }
  const manifestPath = manifests[0];
  const base = manifestPath.slice(0, -'package.json'.length);
  const manifest = parseManifest(archive.get(manifestPath));
  const build = isRecord(manifest.jupyterlab) && isRecord(manifest.jupyterlab._build)
    ? manifest.jupyterlab._build
    : undefined;
  const { name } = manifest;
  const load = build?.load;
  const extension = build?.extension;
  if (typeof name !== 'string' || name === '') {
    throw new Error('The JupyterLab extension has no name.');
  }
  if (typeof load !== 'string' || !load.startsWith('./') || !isSafeRelativePath(load.slice(2))) {
    throw new Error('The JupyterLab extension has no valid remote entry.');
  }
  if (typeof extension !== 'string' || !extension.startsWith('./')) {
    throw new Error('The JupyterLab extension has no valid module.');
  }

  const files = new Map<string, Uint8Array>();
  for (const [path, bytes] of archive) {
    if (!path.startsWith(base)) {
      continue;
    }
    const relative = path.slice(base.length);
    if (!isSafeRelativePath(relative)) {
      throw new Error(`${path} is not a safe path.`);
    }
    files.set(relative, bytes);
  }
  if (!files.has(load.slice(2))) {
    throw new Error(`The remote entry ${load} is not in the wheel.`);
  }
  return { federation: name, load, extension, files };
}

function parseManifest(bytes: Uint8Array | undefined): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('The JupyterLab extension manifest is not valid JSON.');
  }
  if (!isRecord(data)) {
    throw new Error('The JupyterLab extension manifest is not an object.');
  }
  return data;
}
