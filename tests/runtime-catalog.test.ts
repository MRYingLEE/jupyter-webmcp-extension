import { describe, expect, it } from 'vitest';

import {
  IRuntimeArtifact,
  decodeBase64,
  encodeBase64,
  parseArtifacts,
  payloadsFrom,
  sha256Hex,
  usableArtifacts
} from '../src/shared/runtime-catalog';
import { findLabextension, isSafeRelativePath, normalizeName, packageId, selectWheel } from '../src/shared/pypi';
import { readZip } from '../src/shared/zip';

const SHA = 'a'.repeat(64);
const ID = 'pypi:anywidget';
const LABEXTENSION = 'anywidget-0.11.0.data/data/share/jupyter/labextensions/anywidget/';

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Build a zip archive with stored (method 0) or deflated (method 8) entries. */
async function zip(entries: { name: string; data: Uint8Array; method?: number }[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data, method = 0 } of entries) {
    const body = method === 8 ? await deflateRaw(data) : data;
    const nameBytes = new TextEncoder().encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, method, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(10, method, true);
    header.setUint32(20, body.length, true);
    header.setUint32(24, data.length, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), nameBytes);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);
    offset += 30 + nameBytes.length + body.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, central.reduce((total, part) => total + part.length, 0), true);
  end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

const text = (value: string) => new TextEncoder().encode(value);

describe('readZip', () => {
  it('reads stored and deflated entries and skips directories', async () => {
    const archive = await zip([
      { name: 'dir/', data: new Uint8Array() },
      { name: 'dir/a.txt', data: text('stored') },
      { name: 'dir/b.js', data: text('deflated body'), method: 8 }
    ]);
    const files = await readZip(archive);
    expect([...files.keys()]).toEqual(['dir/a.txt', 'dir/b.js']);
    expect(new TextDecoder().decode(files.get('dir/a.txt'))).toBe('stored');
    expect(new TextDecoder().decode(files.get('dir/b.js'))).toBe('deflated body');
  });

  it('rejects bytes that are not a zip archive', async () => {
    await expect(readZip(text('not a zip file at all'))).rejects.toThrow(/not a zip/);
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

describe('package names', () => {
  it('normalizes names per PEP 503 and prefixes the catalog id', () => {
    expect(normalizeName('Any_Widget.Demo--X')).toBe('any-widget-demo-x');
    expect(packageId('AnyWidget')).toBe('pypi:anywidget');
  });
});

describe('selectWheel', () => {
  const wheel = {
    filename: 'anywidget-0.11.0-py3-none-any.whl',
    packagetype: 'bdist_wheel',
    url: 'https://files.pythonhosted.org/packages/a/anywidget-0.11.0-py3-none-any.whl',
    digests: { sha256: SHA }
  };

  it('picks the universal wheel over an sdist and platform wheels', () => {
    const metadata = {
      urls: [
        { filename: 'anywidget-0.11.0.tar.gz', packagetype: 'sdist', url: 'https://x/s', digests: { sha256: SHA } },
        { ...wheel, filename: 'anywidget-0.11.0-cp311-none-macosx.whl' },
        wheel
      ]
    };
    expect(selectWheel(metadata)).toEqual({ filename: wheel.filename, url: wheel.url, sha256: SHA });
  });

  it('rejects a release without a sha256 digest', () => {
    expect(() => selectWheel({ urls: [{ ...wheel, digests: {} }] })).toThrow(/sha256/);
  });

  it('rejects a release without a universal wheel', () => {
    expect(() => selectWheel({ urls: [{ ...wheel, filename: 'a-cp311.whl' }] })).toThrow(/universal/);
  });
});

describe('findLabextension', () => {
  const manifest = {
    name: 'anywidget',
    jupyterlab: {
      _build: { load: './static/remoteEntry.js', extension: './extension' }
    }
  };
  const labextension = (extra: Record<string, Uint8Array> = {}) =>
    new Map<string, Uint8Array>([
      [`${LABEXTENSION}package.json`, text(JSON.stringify(manifest))],
      [`${LABEXTENSION}static/remoteEntry.js`, text('remote')],
      ...Object.entries(extra).map(([path, bytes]) => [`${LABEXTENSION}${path}`, bytes] as [string, Uint8Array])
    ]);

  it('reads the federation name, entries, and files of the labextension', () => {
    const found = findLabextension(labextension({ 'static/extra.js': text('x') }));
    expect(found.federation).toBe('anywidget');
    expect(found.load).toBe('./static/remoteEntry.js');
    expect(found.extension).toBe('./extension');
    expect([...found.files.keys()].sort()).toEqual(['package.json', 'static/extra.js', 'static/remoteEntry.js']);
  });

  it('rejects a wheel with more than one labextension', () => {
    const archive = labextension();
    archive.set('other-1.0.data/data/share/jupyter/labextensions/other/package.json', text('{}'));
    expect(() => findLabextension(archive)).toThrow(/more than one/);
  });

  it('rejects a remote entry that is not in the wheel', () => {
    const archive = labextension();
    archive.delete(`${LABEXTENSION}static/remoteEntry.js`);
    expect(() => findLabextension(archive)).toThrow(/remote entry/);
  });
});

describe('artifacts', () => {
  const artifact: IRuntimeArtifact = {
    version: '0.11.0',
    federation: 'anywidget',
    load: './static/remoteEntry.js',
    extension: './extension',
    urls: { 'static/remoteEntry.js': 'blob:https://x/1' }
  };

  it('drops an artifact whose version the page blocked', () => {
    const table = { [ID]: artifact };
    expect(usableArtifacts(table, { [ID]: '0.11.0' })).toEqual({});
    expect(usableArtifacts(table, { [ID]: '0.10.0' })).toEqual({ [ID]: artifact });
  });

  it('drops an artifact whose remote entry has no blob URL', () => {
    expect(usableArtifacts({ [ID]: { ...artifact, urls: {} } }, {})).toEqual({});
  });

  it('reads the artifact table the bridge writes and ignores malformed input', () => {
    const json = JSON.stringify({ [ID]: artifact, 'not-a-package': artifact });
    expect(parseArtifacts(json)).toEqual({ [ID]: artifact });
    expect(parseArtifacts('{not json')).toEqual({});
    expect(parseArtifacts(null)).toEqual({});
  });

  it('keeps only well-formed cached payloads for package ids', () => {
    const payload = {
      version: '0.11.0',
      federation: 'anywidget',
      load: './static/remoteEntry.js',
      extension: './extension',
      files: { 'static/remoteEntry.js': 'AA==' }
    };
    const cached = { [ID]: payload, 'not-a-package': payload, broken: { version: 1 } };
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
