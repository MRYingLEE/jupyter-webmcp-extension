/**
 * A minimal zip reader for wheels: stored and deflated entries, read from the
 * central directory. Deflate uses the platform's `DecompressionStream`, so no
 * library is bundled. Zip64 archives are rejected.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;
const END_RECORD_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

async function inflate(method: number, data: Uint8Array): Promise<Uint8Array> {
  if (method === METHOD_STORED) {
    return data;
  }
  if (method !== METHOD_DEFLATE) {
    throw new Error(`The archive uses an unsupported compression method (${method}).`);
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read every file of a zip archive, by its path. Directory entries are skipped.
 *
 * @throws Error when the bytes are not a readable zip archive.
 */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.length - END_RECORD_SIZE - MAX_COMMENT_SIZE);
  let end = -1;
  for (let offset = bytes.length - END_RECORD_SIZE; offset >= lowest; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) {
      end = offset;
      break;
    }
  }
  if (end < 0) {
    throw new Error('The file is not a zip archive.');
  }
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count === 0xffff || offset === ZIP64_MARKER) {
    throw new Error('Zip64 archives are not supported.');
  }

  const files = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_HEADER) {
      throw new Error('The archive directory is damaged.');
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (compressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      throw new Error('Zip64 archives are not supported.');
    }
    if (name.endsWith('/')) {
      continue;
    }
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_HEADER) {
      throw new Error(`The archive entry ${name} is damaged.`);
    }
    const start =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (start + compressedSize > bytes.length) {
      throw new Error(`The archive entry ${name} is truncated.`);
    }
    files.set(name, await inflate(method, bytes.subarray(start, start + compressedSize)));
  }
  return files;
}
