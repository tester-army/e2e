/**
 * A minimal zip codec for rewriting archives an engine produced (a Playwright
 * trace is one). Reads by the central directory, so entries written with a
 * data descriptor (sizes after the data, which is how Playwright's writer
 * streams them) resolve, and writes plain deflated entries with the sizes up
 * front. No zip64, no encryption, no multi-disk: a trace archive needs none of
 * them, and an archive that does is refused rather than half-read.
 */

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;
const ZIP64_MARKER_16 = 0xffff;
/** General-purpose flag: names and comments are UTF-8. */
const FLAG_UTF8 = 0x0800;
const STORED = 0;
const DEFLATED = 8;

/** One archive member with its stored bytes; `inflateEntry` decodes them. */
export interface ZipEntry {
  readonly name: string;
  /** DOS-format modification time and date, carried through as stored. */
  readonly dosTime: number;
  readonly dosDate: number;
  readonly method: typeof STORED | typeof DEFLATED;
  readonly crc32: number;
  /** Uncompressed size in bytes. */
  readonly size: number;
  readonly compressed: Uint8Array;
}

/** Parses an archive's central directory into its entries. */
export function readZip(archive: Uint8Array): ZipEntry[] {
  const buffer = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (entryCount === ZIP64_MARKER_16 || directoryOffset === ZIP64_MARKER_32) {
    throw new Error('zip64 archives are not supported');
  }
  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + CENTRAL_HEADER_SIZE > end || buffer.readUInt32LE(offset) !== CENTRAL_HEADER) {
      throw new Error('malformed zip: central directory entry expected');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const dosTime = buffer.readUInt16LE(offset + 12);
    const dosDate = buffer.readUInt16LE(offset + 14);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (compressedSize === ZIP64_MARKER_32 || size === ZIP64_MARKER_32 || localOffset === ZIP64_MARKER_32) {
      throw new Error('zip64 archives are not supported');
    }
    if (method !== STORED && method !== DEFLATED) {
      throw new Error(`unsupported zip compression method ${String(method)}`);
    }
    const name = buffer.toString('utf8', offset + CENTRAL_HEADER_SIZE, offset + CENTRAL_HEADER_SIZE + nameLength);
    offset += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;

    // The local header's own name and extra lengths decide where the data
    // starts; they may differ from the central directory's.
    if (localOffset + LOCAL_HEADER_SIZE > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_HEADER) {
      throw new Error(`malformed zip: local header expected for ${name}`);
    }
    const dataStart =
      localOffset +
      LOCAL_HEADER_SIZE +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > buffer.length) {
      throw new Error(`malformed zip: entry ${name} runs past the archive`);
    }
    entries.push({
      name,
      dosTime,
      dosDate,
      method,
      crc32: checksum,
      size,
      compressed: buffer.subarray(dataStart, dataStart + compressedSize),
    });
  }
  return entries;
}

/** Decodes one entry's bytes, verifying the stored checksum. */
export function inflateEntry(entry: ZipEntry): Buffer {
  const data =
    entry.method === STORED
      ? Buffer.from(entry.compressed.buffer, entry.compressed.byteOffset, entry.compressed.byteLength)
      : inflateRawSync(entry.compressed);
  if (data.length !== entry.size || crc32(data) !== entry.crc32) {
    throw new Error(`malformed zip: entry ${entry.name} does not match its stored size or checksum`);
  }
  return data;
}

/** A deflated entry holding `data`, timestamped like `like` when given. */
export function zipEntry(name: string, data: Uint8Array, like?: Pick<ZipEntry, 'dosTime' | 'dosDate'>): ZipEntry {
  const stamp = like ?? dosStamp(new Date());
  return {
    name,
    dosTime: stamp.dosTime,
    dosDate: stamp.dosDate,
    method: DEFLATED,
    crc32: crc32(data),
    size: data.byteLength,
    compressed: deflateRawSync(data),
  };
}

/** Serializes entries into one archive. */
export function writeZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (entry.compressed.byteLength >= ZIP64_MARKER_32 || entry.size >= ZIP64_MARKER_32 || offset >= ZIP64_MARKER_32) {
      throw new Error('archive too large: zip64 is not supported');
    }
    const local = Buffer.alloc(LOCAL_HEADER_SIZE + name.length);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(entry.dosTime, 10);
    local.writeUInt16LE(entry.dosDate, 12);
    local.writeUInt32LE(entry.crc32, 14);
    local.writeUInt32LE(entry.compressed.byteLength, 18);
    local.writeUInt32LE(entry.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, LOCAL_HEADER_SIZE);

    const central = Buffer.alloc(CENTRAL_HEADER_SIZE + name.length);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(entry.dosTime, 12);
    central.writeUInt16LE(entry.dosDate, 14);
    central.writeUInt32LE(entry.crc32, 16);
    central.writeUInt32LE(entry.compressed.byteLength, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    name.copy(central, CENTRAL_HEADER_SIZE);

    locals.push(local, Buffer.from(entry.compressed.buffer, entry.compressed.byteOffset, entry.compressed.byteLength));
    centrals.push(central);
    offset += local.length + entry.compressed.byteLength;
  }
  const directorySize = centrals.reduce((total, central) => total + central.length, 0);
  if (entries.length >= ZIP64_MARKER_16 || offset + directorySize >= ZIP64_MARKER_32) {
    throw new Error('archive too large: zip64 is not supported');
  }
  const end = Buffer.alloc(END_SIZE);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // directory disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Locates the end-of-central-directory record, which may be followed by a comment. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const floor = Math.max(0, buffer.length - END_SIZE - MAX_COMMENT);
  for (let offset = buffer.length - END_SIZE; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + END_SIZE + commentLength === buffer.length) return offset;
  }
  throw new Error('malformed zip: no end of central directory');
}

function dosStamp(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}
