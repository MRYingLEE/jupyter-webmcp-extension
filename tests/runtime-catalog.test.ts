import { describe, expect, it } from 'vitest';

import { CATALOG, CatalogBuilds, catalogEntry } from '../src/shared/catalog';
import {
  IRuntimeArtifact,
  RUNTIME_MANIFEST_SCHEMA,
  decodeBase64,
  encodeBase64,
  isSafeRelativePath,
  mergeBuilds,
  parseArtifacts,
  parseRuntimeManifest,
  payloadsFrom,
  sha256Hex,
  usableArtifacts
} from '../src/shared/runtime-catalog';

const MANIFEST_URL = 'https://catalog.example.com/jwe/manifest.json';
const SHA = 'a'.repeat(64);

const ID = CATALOG[0].id;
const FEDERATION = catalogEntry(ID)!.federation;

function manifest(entry: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: RUNTIME_MANIFEST_SCHEMA,
    entries: [
      {
        id: ID,
        federation: FEDERATION,
        version: '1.2.3',
        base: `${ID}/`,
        load: './static/remoteEntry.js',
        extension: './extension',
        files: [{ path: 'static/remoteEntry.js', sha256: SHA }],
        ...entry
      }
    ]
  });
}

describe('parseRuntimeManifest', () => {
  it('accepts a well-formed manifest', () => {
    const parsed = parseRuntimeManifest(manifest(), MANIFEST_URL);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].files[0]).toEqual({ path: 'static/remoteEntry.js', sha256: SHA });
  });

  it('rejects a federation name that differs from the pins', () => {
    expect(() => parseRuntimeManifest(manifest({ federation: 'other' }), MANIFEST_URL)).toThrow(
      /federation/
    );
  });

  it('rejects an id that the pins do not name', () => {
    expect(() => parseRuntimeManifest(manifest({ id: 'not-a-catalog-id' }), MANIFEST_URL)).toThrow(
      /Unknown catalog id/
    );
  });

  it('rejects a base or file path that escapes its directory or origin', () => {
    expect(() => parseRuntimeManifest(manifest({ base: '../evil/' }), MANIFEST_URL)).toThrow();
    expect(() => parseRuntimeManifest(manifest({ base: '//evil.example/' }), MANIFEST_URL)).toThrow();
    expect(() =>
      parseRuntimeManifest(
        manifest({ files: [{ path: '../secret.js', sha256: SHA }], load: './../secret.js' }),
        MANIFEST_URL
      )
    ).toThrow();
  });

  it('rejects a sha256 that is not 64 lowercase hex digits', () => {
    expect(() =>
      parseRuntimeManifest(manifest({ files: [{ path: 'static/remoteEntry.js', sha256: 'XYZ' }] }), MANIFEST_URL)
    ).toThrow(/sha256/);
  });

  it('rejects a load that is not one of the listed files', () => {
    expect(() => parseRuntimeManifest(manifest({ load: './static/other.js' }), MANIFEST_URL)).toThrow(
      /not in the files/
    );
  });
});

describe('isSafeRelativePath', () => {
  it('rejects absolute, scheme, query, and dot-segment paths', () => {
    expect(isSafeRelativePath('static/a.js')).toBe(true);
    for (const path of ['/a.js', 'a\\b.js', 'https:a.js', 'a.js?x', 'a/../b.js', 'a//b.js', './a.js']) {
      expect(isSafeRelativePath(path)).toBe(false);
    }
  });
});

describe('artifacts', () => {
  const artifact: IRuntimeArtifact = {
    version: '1.2.3',
    load: './static/remoteEntry.js',
    extension: './extension',
    urls: { 'static/remoteEntry.js': 'blob:https://x/1' }
  };

  it('drops an artifact whose version the page blocked', () => {
    const table = { [ID]: artifact };
    expect(usableArtifacts(table, { [ID]: '1.2.3' })).toEqual({});
    expect(usableArtifacts(table, { [ID]: '1.2.2' })).toEqual({ [ID]: artifact });
  });

  it('drops an artifact whose remote entry has no blob URL', () => {
    expect(usableArtifacts({ [ID]: { ...artifact, urls: {} } }, {})).toEqual({});
  });

  it('replaces bundled builds with the usable artifacts', () => {
    const bundled: CatalogBuilds = { other: { load: './bundled.js', extension: './e' } };
    const merged = mergeBuilds(bundled, { [ID]: artifact });
    expect(merged[ID]).toEqual({ load: artifact.load, extension: artifact.extension });
    expect(merged.other).toEqual(bundled.other);
  });

  it('reads the artifact table the bridge writes and ignores malformed input', () => {
    const text = JSON.stringify({ [ID]: artifact, unknown: artifact });
    expect(parseArtifacts(text)).toEqual({ [ID]: artifact });
    expect(parseArtifacts('{not json')).toEqual({});
    expect(parseArtifacts(null)).toEqual({});
  });

  it('keeps only well-formed cached payloads for known catalog ids', () => {
    const payload = { version: '1.2.3', load: './static/remoteEntry.js', extension: './extension', files: { 'static/remoteEntry.js': 'AA==' } };
    const cached = { [ID]: payload, unknown: payload, broken: { version: 1 }, [`${ID}-bad`]: payload };
    expect(payloadsFrom(cached)).toEqual({ [ID]: payload });
    expect(payloadsFrom('not a record')).toEqual({});
  });
});

describe('bytes', () => {
  it('round-trips base64 and computes sha256', async () => {
    const bytes = new TextEncoder().encode('export default 1;').buffer as ArrayBuffer;
    expect(new TextDecoder().decode(decodeBase64(encodeBase64(bytes)))).toBe('export default 1;');
    expect(await sha256Hex(new ArrayBuffer(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });
});
