import { describe, expect, it } from 'vitest';
import { buildIso } from './iso9660';

const SECTOR = 2048;

/** Read one directory's records: the reader a guest effectively is. */
function readDirectory(iso: Buffer, extent: number, size: number, joliet: boolean) {
  const entries: { name: string; extent: number; size: number; directory: boolean }[] = [];
  let offset = extent * SECTOR;
  const end = offset + size;
  while (offset < end) {
    const length = iso[offset]!;
    if (length === 0) {
      offset = (Math.floor(offset / SECTOR) + 1) * SECTOR;
      continue;
    }
    const nameLength = iso[offset + 32]!;
    const raw = iso.subarray(offset + 33, offset + 33 + nameLength);
    let name: string;
    if (nameLength === 1 && (raw[0] === 0 || raw[0] === 1)) name = raw[0] === 0 ? '.' : '..';
    else if (joliet) {
      name = '';
      for (let i = 0; i < raw.length; i += 2) name += String.fromCharCode(raw.readUInt16BE(i));
    } else name = raw.toString('ascii');
    entries.push({
      name,
      extent: iso.readUInt32LE(offset + 2),
      size: iso.readUInt32LE(offset + 10),
      directory: (iso[offset + 25]! & 2) !== 0,
    });
    offset += length;
  }
  return entries;
}

function rootOf(iso: Buffer, descriptorSector: number) {
  const d = descriptorSector * SECTOR;
  return { extent: iso.readUInt32LE(d + 156 + 2), size: iso.readUInt32LE(d + 156 + 10) };
}

const files = [
  { name: 'user-data', content: Buffer.from('#cloud-config\n{}\n') },
  { name: 'meta-data', content: Buffer.from('instance-id: abc\n') },
  { name: 'network-config', content: Buffer.alloc(5000, 0x41) },
];

describe('buildIso', () => {
  const iso = buildIso({ label: 'cidata', files, date: new Date(Date.UTC(2026, 8, 30, 12, 0, 0)) });

  it('is whole sectors, with the three descriptors where readers look', () => {
    expect(iso.length % SECTOR).toBe(0);
    expect(iso.subarray(16 * SECTOR + 1, 16 * SECTOR + 6).toString('ascii')).toBe('CD001');
    expect(iso[16 * SECTOR]).toBe(1);
    expect(iso[17 * SECTOR]).toBe(2);
    expect(iso[18 * SECTOR]).toBe(255);
  });

  it('states its own size correctly', () => {
    expect(iso.readUInt32LE(16 * SECTOR + 80) * SECTOR).toBe(iso.length);
    expect(iso.readUInt32BE(16 * SECTOR + 84) * SECTOR).toBe(iso.length);
  });

  it('marks the supplementary descriptor as Joliet level 3', () => {
    expect(iso.subarray(17 * SECTOR + 88, 17 * SECTOR + 91).toString('ascii')).toBe('%/E');
  });

  it('carries the label NoCloud looks for, in both trees', () => {
    expect(iso.subarray(16 * SECTOR + 40, 16 * SECTOR + 46).toString('ascii')).toBe('CIDATA');
    const joliet = iso.subarray(17 * SECTOR + 40, 17 * SECTOR + 52);
    let label = '';
    for (let i = 0; i < joliet.length; i += 2) label += String.fromCharCode(joliet.readUInt16BE(i));
    expect(label).toBe('cidata');
  });

  it('lists the real names in the Joliet tree, and the bytes are there', () => {
    const root = rootOf(iso, 17);
    const entries = readDirectory(iso, root.extent, root.size, true);
    expect(entries.map((e) => e.name)).toEqual(['.', '..', 'meta-data', 'network-config', 'user-data']);
    for (const file of files) {
      const entry = entries.find((e) => e.name === file.name)!;
      expect(entry.size).toBe(file.content.length);
      const bytes = iso.subarray(entry.extent * SECTOR, entry.extent * SECTOR + entry.size);
      expect(bytes.equals(file.content)).toBe(true);
    }
  });

  it('lists 8.3 names in the primary tree, pointing at the same bytes', () => {
    const root = rootOf(iso, 16);
    const entries = readDirectory(iso, root.extent, root.size, false);
    expect(entries.map((e) => e.name)).toEqual(['.', '..', 'META_DAT.;1', 'NETWORK_.;1', 'USER_DAT.;1']);
    const joliet = readDirectory(iso, rootOf(iso, 17).extent, rootOf(iso, 17).size, true);
    expect(entries.find((e) => e.name === 'USER_DAT.;1')!.extent).toBe(
      joliet.find((e) => e.name === 'user-data')!.extent,
    );
  });

  it('keeps 8.3 names unique when two names collapse to the same one', () => {
    const out = buildIso({
      label: 'x',
      files: [
        { name: 'Autounattend.xml', content: Buffer.from('<a/>') },
        { name: 'Autounattend-2.xml', content: Buffer.from('<b/>') },
      ],
    });
    const root = rootOf(out, 16);
    const names = readDirectory(out, root.extent, root.size, false).map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('AUTOUNAT.XML;1');
  });

  it('refuses names a guest would not read back as written', () => {
    expect(() => buildIso({ label: 'x', files: [{ name: '../x', content: Buffer.alloc(1) }] })).toThrow();
    expect(() =>
      buildIso({
        label: 'x',
        files: [
          { name: 'A.xml', content: Buffer.alloc(1) },
          { name: 'a.XML', content: Buffer.alloc(1) },
        ],
      }),
    ).toThrow();
  });

  it('is byte-for-byte reproducible for the same input and date', () => {
    const again = buildIso({ label: 'cidata', files, date: new Date(Date.UTC(2026, 8, 30, 12, 0, 0)) });
    expect(again.equals(iso)).toBe(true);
  });
});
