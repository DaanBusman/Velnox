/**
 * A small ISO 9660 writer, with Joliet names, for answer media.
 *
 * Provisioning hands a guest its configuration on a CD: Windows Setup looks for
 * `Autounattend.xml` at the root of every removable drive, and cloud-init's
 * NoCloud source reads `user-data` and `meta-data` from a volume labelled
 * `cidata`. Proxmox can attach an ISO from any storage that takes `iso`
 * content, and upload one through the same call the library already uses — so
 * an ISO is the one delivery that needs nothing on the node beyond what Velnox
 * already has. (Proxmox's own cloud-init drive needs a `snippets` storage and a
 * file written to it, which its API cannot do.)
 *
 * Deliberately small: one directory, a handful of files, a few kilobytes each.
 * Two directory trees are written — the ISO 9660 one, whose names are 8.3 and
 * upper case, and a Joliet one carrying the real names, which is what Windows
 * and Linux both read when it is there.
 *
 * Layout, in 2048-byte sectors:
 *
 *   0–15  system area, zero
 *   16    primary volume descriptor
 *   17    supplementary volume descriptor (Joliet, UCS-2 level 3)
 *   18    descriptor set terminator
 *   19–22 path tables: primary L and M, Joliet L and M
 *   …     primary root directory, Joliet root directory, then each file
 */

export interface IsoFile {
  /** The name as the guest should see it: `Autounattend.xml`, `user-data`. */
  name: string;
  content: Buffer;
}

export interface IsoOptions {
  /** The volume label. NoCloud looks for `cidata`. */
  label: string;
  files: IsoFile[];
  /** For reproducible output in tests; the current time otherwise. */
  date?: Date;
}

const SECTOR = 2048;

const bothEndian32 = (value: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(value, 0);
  b.writeUInt32BE(value, 4);
  return b;
};

const bothEndian16 = (value: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(value, 0);
  b.writeUInt16BE(value, 2);
  return b;
};

const sectors = (bytes: number): number => Math.max(1, Math.ceil(bytes / SECTOR));

/** Seven-byte directory record date, in UTC. */
function recordDate(date: Date): Buffer {
  return Buffer.from([
    date.getUTCFullYear() - 1900,
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    0,
  ]);
}

/** Seventeen-byte volume descriptor date: sixteen digits and a zone byte. */
function volumeDate(date: Date | null): Buffer {
  if (!date) return Buffer.concat([Buffer.from('0'.repeat(16), 'ascii'), Buffer.from([0])]);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const text =
    pad(date.getUTCFullYear(), 4) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    '00';
  return Buffer.concat([Buffer.from(text, 'ascii'), Buffer.from([0])]);
}

/** An ASCII field padded with spaces. */
const ascii = (text: string, length: number): Buffer =>
  Buffer.from(text.slice(0, length).padEnd(length, ' '), 'ascii');

/** A UCS-2 big-endian field padded with UCS-2 spaces. */
function ucs2(text: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i + 1 < length; i += 2) out.writeUInt16BE(0x0020, i);
  const chars = Math.floor(length / 2);
  for (let i = 0; i < Math.min(text.length, chars); i += 1) {
    out.writeUInt16BE(text.charCodeAt(i), i * 2);
  }
  return out;
}

const ucs2Name = (name: string): Buffer => {
  const out = Buffer.alloc(name.length * 2);
  for (let i = 0; i < name.length; i += 1) out.writeUInt16BE(name.charCodeAt(i), i * 2);
  return out;
};

/**
 * The 8.3 name ISO 9660 level 1 requires: upper case, `[A-Z0-9_]`, a dot, and
 * `;1`. Made unique by replacing the tail of the base with a counter.
 */
function primaryNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const rawBase = dot > 0 ? name.slice(0, dot) : name;
    const rawExt = dot > 0 ? name.slice(dot + 1) : '';
    const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const ext = clean(rawExt).slice(0, 3);
    let base = clean(rawBase).slice(0, 8) || '_';
    let candidate = `${base}.${ext};1`;
    for (let n = 1; used.has(candidate); n += 1) {
      const suffix = `_${n}`;
      base = clean(rawBase).slice(0, 8 - suffix.length) + suffix;
      candidate = `${base}.${ext};1`;
    }
    used.add(candidate);
    return candidate;
  });
}

interface Entry {
  name: Buffer;
  extent: number;
  size: number;
  directory: boolean;
}

function directoryRecord(entry: Entry, date: Date): Buffer {
  const nameLength = entry.name.length;
  const length = 33 + nameLength + (nameLength % 2 === 0 ? 1 : 0);
  const record = Buffer.alloc(length);
  record[0] = length;
  record[1] = 0;
  bothEndian32(entry.extent).copy(record, 2);
  bothEndian32(entry.size).copy(record, 10);
  recordDate(date).copy(record, 18);
  record[25] = entry.directory ? 0x02 : 0x00;
  record[26] = 0;
  record[27] = 0;
  bothEndian16(1).copy(record, 28);
  record[32] = nameLength;
  entry.name.copy(record, 33);
  return record;
}

/**
 * A directory's bytes. A record may not cross a sector boundary, so one that
 * would is moved to the start of the next sector.
 */
function directoryBytes(records: Buffer[]): Buffer {
  const chunks: Buffer[] = [];
  let used = 0;
  for (const record of records) {
    const room = SECTOR - (used % SECTOR);
    if (record.length > room) {
      chunks.push(Buffer.alloc(room));
      used += room;
    }
    chunks.push(record);
    used += record.length;
  }
  const total = sectors(used) * SECTOR;
  chunks.push(Buffer.alloc(total - used));
  return Buffer.concat(chunks);
}

/** One path table with only the root in it. */
function pathTable(rootExtent: number, bigEndian: boolean): Buffer {
  const entry = Buffer.alloc(10);
  entry[0] = 1; // name length
  entry[1] = 0;
  if (bigEndian) {
    entry.writeUInt32BE(rootExtent, 2);
    entry.writeUInt16BE(1, 6);
  } else {
    entry.writeUInt32LE(rootExtent, 2);
    entry.writeUInt16LE(1, 6);
  }
  entry[8] = 0; // the root's name is a single zero byte
  entry[9] = 0; // padding to even
  return entry;
}

function volumeDescriptor(input: {
  type: 1 | 2;
  label: Buffer;
  system: Buffer;
  volumeSetId: Buffer;
  publisher: Buffer;
  preparer: Buffer;
  application: Buffer;
  fileIds: Buffer;
  totalSectors: number;
  pathTableSize: number;
  lPath: number;
  mPath: number;
  root: Buffer;
  date: Date;
}): Buffer {
  const d = Buffer.alloc(SECTOR);
  d[0] = input.type;
  d.write('CD001', 1, 'ascii');
  d[6] = 1;
  input.system.copy(d, 8);
  input.label.copy(d, 40);
  bothEndian32(input.totalSectors).copy(d, 80);
  // Joliet's escape sequence: UCS-2 level 3.
  if (input.type === 2) Buffer.from('%/E', 'ascii').copy(d, 88);
  bothEndian16(1).copy(d, 120);
  bothEndian16(1).copy(d, 124);
  bothEndian16(SECTOR).copy(d, 128);
  bothEndian32(input.pathTableSize).copy(d, 132);
  d.writeUInt32LE(input.lPath, 140);
  d.writeUInt32BE(input.mPath, 148);
  input.root.copy(d, 156);
  input.volumeSetId.copy(d, 190);
  input.publisher.copy(d, 318);
  input.preparer.copy(d, 446);
  input.application.copy(d, 574);
  input.fileIds.copy(d, 702); // copyright, abstract and bibliographic: 3 × 37
  volumeDate(input.date).copy(d, 813);
  volumeDate(input.date).copy(d, 830);
  volumeDate(null).copy(d, 847);
  volumeDate(null).copy(d, 864);
  d[881] = 1;
  return d;
}

export function buildIso(options: IsoOptions): Buffer {
  const date = options.date ?? new Date();
  if (options.files.length === 0) throw new Error('An answer ISO needs at least one file');
  if (options.files.length > 30) throw new Error('An answer ISO holds at most 30 files');
  for (const file of options.files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(file.name)) {
      throw new Error(`"${file.name}" is not a name an answer ISO carries`);
    }
  }
  const lowered = options.files.map((f) => f.name.toLowerCase());
  if (new Set(lowered).size !== lowered.length) throw new Error('File names repeat');

  const files = [...options.files];
  const primary = primaryNames(files.map((f) => f.name));

  // Sector numbers, decided before anything is written.
  const LPATH = 19;
  const MPATH = 20;
  const JLPATH = 21;
  const JMPATH = 22;
  const PRIMARY_ROOT = 23;

  // Directory sizes depend on names only, so they can be computed first.
  const dummyDate = date;
  const recordFor = (name: Buffer, directory: boolean) =>
    directoryRecord({ name, extent: 0, size: 0, directory }, dummyDate);
  const dots = [recordFor(Buffer.from([0]), true), recordFor(Buffer.from([1]), true)];
  const primaryRootSize =
    directoryBytes([...dots, ...primary.map((n) => recordFor(Buffer.from(n, 'ascii'), false))])
      .length;
  const jolietRootSize =
    directoryBytes([...dots, ...files.map((f) => recordFor(ucs2Name(f.name), false))]).length;

  const JOLIET_ROOT = PRIMARY_ROOT + primaryRootSize / SECTOR;
  let next = JOLIET_ROOT + jolietRootSize / SECTOR;
  const extents = files.map((file) => {
    const extent = next;
    next += sectors(file.content.length);
    return extent;
  });
  const totalSectors = next;

  // Both trees point at the same file data.
  const sortBy = <T>(items: T[], key: (item: T) => Buffer) =>
    [...items].sort((a, b) => Buffer.compare(key(a), key(b)));

  const primaryEntries = sortBy(
    files.map((file, i) => ({
      name: Buffer.from(primary[i]!, 'ascii'),
      extent: extents[i]!,
      size: file.content.length,
      directory: false,
    })),
    (e) => e.name,
  );
  const jolietEntries = sortBy(
    files.map((file, i) => ({
      name: ucs2Name(file.name),
      extent: extents[i]!,
      size: file.content.length,
      directory: false,
    })),
    (e) => e.name,
  );

  const rootRecord = (extent: number, size: number, name: Buffer) =>
    directoryRecord({ name, extent, size, directory: true }, date);

  const primaryRoot = directoryBytes([
    rootRecord(PRIMARY_ROOT, primaryRootSize, Buffer.from([0])),
    rootRecord(PRIMARY_ROOT, primaryRootSize, Buffer.from([1])),
    ...primaryEntries.map((e) => directoryRecord(e, date)),
  ]);
  const jolietRoot = directoryBytes([
    rootRecord(JOLIET_ROOT, jolietRootSize, Buffer.from([0])),
    rootRecord(JOLIET_ROOT, jolietRootSize, Buffer.from([1])),
    ...jolietEntries.map((e) => directoryRecord(e, date)),
  ]);

  const common = {
    totalSectors,
    pathTableSize: 10,
    date,
  };
  const primaryDescriptor = volumeDescriptor({
    ...common,
    type: 1,
    label: ascii(options.label.toUpperCase().replace(/[^A-Z0-9_]/g, '_'), 32),
    system: ascii('', 32),
    volumeSetId: ascii('', 128),
    publisher: ascii('', 128),
    preparer: ascii('VELNOX', 128),
    application: ascii('VELNOX', 128),
    fileIds: ascii('', 111),
    lPath: LPATH,
    mPath: MPATH,
    root: rootRecord(PRIMARY_ROOT, primaryRootSize, Buffer.from([0])),
  });
  const jolietDescriptor = volumeDescriptor({
    ...common,
    type: 2,
    label: ucs2(options.label, 32),
    system: ucs2('', 32),
    volumeSetId: ucs2('', 128),
    publisher: ucs2('', 128),
    preparer: ucs2('Velnox', 128),
    application: ucs2('Velnox', 128),
    fileIds: Buffer.concat([ucs2('', 37), ucs2('', 37), ucs2('', 37)]),
    lPath: JLPATH,
    mPath: JMPATH,
    root: rootRecord(JOLIET_ROOT, jolietRootSize, Buffer.from([0])),
  });
  const terminator = Buffer.alloc(SECTOR);
  terminator[0] = 255;
  terminator.write('CD001', 1, 'ascii');
  terminator[6] = 1;

  const sector = (content: Buffer) => {
    const out = Buffer.alloc(sectors(content.length) * SECTOR);
    content.copy(out);
    return out;
  };

  return Buffer.concat([
    Buffer.alloc(16 * SECTOR),
    primaryDescriptor,
    jolietDescriptor,
    terminator,
    sector(pathTable(PRIMARY_ROOT, false)),
    sector(pathTable(PRIMARY_ROOT, true)),
    sector(pathTable(JOLIET_ROOT, false)),
    sector(pathTable(JOLIET_ROOT, true)),
    primaryRoot,
    jolietRoot,
    ...files.map((file) => sector(file.content)),
  ]);
}
