/** The minimal zip codec: round trips, data-descriptor archives, and what it refuses. */

import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inflateEntry, readZip, writeZip, zipEntry } from '../../src/internal/zip.ts';

/**
 * An archive the way a streaming writer (yazl, which Playwright bundles)
 * lays it out: general-purpose bit 3 set, zeros for the checksum and sizes in
 * the local header, a data descriptor after the data, and the real values
 * only in the central directory.
 */
function dataDescriptorArchive(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0008 | 0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x6000, 10);
    local.writeUInt16LE(0x5c21, 12);
    // crc and sizes are zero here; the descriptor carries them.
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc32(data), 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(data.length, 12);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0008 | 0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x6000, 12);
    central.writeUInt16LE(0x5c21, 14);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    parts.push(local, compressed, descriptor);
    centrals.push(central);
    offset += local.length + compressed.length + descriptor.length;
  }
  const directorySize = centrals.reduce((total, central) => total + central.length, 0);
  const comment = Buffer.from('trailing comment');
  const end = Buffer.alloc(22 + comment.length);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  comment.copy(end, 22);
  return Buffer.concat([...parts, ...centrals, end]);
}

describe('zip codec', () => {
  it('round-trips entries through writeZip and readZip, preserving names, bytes, and timestamps', () => {
    const stamp = { dosTime: 0x1234, dosDate: 0x5678 };
    const text = zipEntry('trace.trace', Buffer.from('{"type":"before"}\n'), stamp);
    const binary = zipEntry('resources/α.jpeg', Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xfe]));
    const archive = writeZip([text, binary]);

    const read = readZip(archive);
    expect(read.map((entry) => entry.name)).toEqual(['trace.trace', 'resources/α.jpeg']);
    expect(read[0]).toMatchObject(stamp);
    expect(inflateEntry(read[0]!).toString('utf8')).toBe('{"type":"before"}\n');
    expect([...inflateEntry(read[1]!)]).toEqual([0xff, 0xd8, 0x00, 0x01, 0xfe]);
  });

  it('reads an archive written with data descriptors and a trailing comment', () => {
    const archive = dataDescriptorArchive([
      { name: 'trace.trace', data: Buffer.from('first') },
      { name: 'trace.network', data: Buffer.from('second entry, longer') },
    ]);
    const read = readZip(archive);
    expect(read.map((entry) => [entry.name, inflateEntry(entry).toString()])).toEqual([
      ['trace.trace', 'first'],
      ['trace.network', 'second entry, longer'],
    ]);
    // Entries carried through as stored keep their original compressed bytes.
    const rewritten = readZip(writeZip(read));
    expect(rewritten.map((entry) => inflateEntry(entry).toString())).toEqual(['first', 'second entry, longer']);
  });

  it('refuses what it cannot represent: corrupt data, a wrong checksum, and zip64 markers', () => {
    expect(() => readZip(Buffer.from('not a zip at all'))).toThrow(/end of central directory/);

    const entry = zipEntry('a.txt', Buffer.from('hello'));
    expect(() => inflateEntry({ ...entry, crc32: entry.crc32 ^ 1 })).toThrow(/checksum/);

    const archive = writeZip([entry]);
    // The central directory's local-header offset, marked as zip64.
    const directoryOffset = archive.readUInt32LE(archive.length - 22 + 16);
    archive.writeUInt32LE(0xffffffff, directoryOffset + 42);
    expect(() => readZip(archive)).toThrow(/zip64/);
  });
});
