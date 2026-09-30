import { open, type FileHandle } from 'node:fs/promises';

/**
 * The editions inside a Windows ISO, read from the ISO itself.
 *
 * An Autounattend.xml picks the edition to install by its name in the image's
 * own list. A dropdown that does not read that list is a dropdown that lets
 * someone choose "Windows 11 Pro" for an ISO that calls it something else — and
 * Setup, finding no match, installs whatever comes first. So when a Windows ISO
 * enters the library, the list is read and kept, and the template form offers
 * exactly those names.
 *
 * Two formats, read-only and only as far as needed:
 *
 * - **UDF**, the filesystem of every Windows install ISO (the ISO 9660 part
 *   holds only a README saying so). Enough of it to walk from the root to
 *   `sources/install.wim` or `install.esd` and find where that file's bytes are.
 * - **WIM**, whose header points at an XML document, stored uncompressed even in
 *   an ESD, that lists every image: index, name, edition, languages.
 *
 * Anything unexpected — a UDF feature this does not read, a WIM that does not
 * start as one should — gives `null`, never a guess. The form then says the
 * list could not be read, and the edition is typed and unchecked.
 */

export interface WindowsImage {
  index: number;
  /** What `/IMAGE/NAME` matches: `Windows 11 Pro`. */
  name: string;
  displayName: string | null;
  /** `Professional`, `ServerStandard`, … */
  editionId: string | null;
  /** `x64`, `arm64`, `x86`. */
  architecture: string | null;
  languages: string[];
}

const SECTOR = 2048;
/** UDF descriptor tag identifiers used here. */
const TAG = {
  anchor: 2,
  partition: 5,
  logicalVolume: 6,
  terminating: 8,
  fileSet: 256,
  fileIdentifier: 257,
  fileEntry: 261,
  extendedFileEntry: 266,
} as const;

/** A contiguous run of a file's bytes on the disc. */
interface Extent {
  /** Byte offset in the ISO. */
  position: number;
  length: number;
}

class Reader {
  constructor(private readonly handle: FileHandle) {}

  async read(position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new Error('short read');
    return buffer;
  }

  async readExtents(extents: Extent[], offset: number, length: number): Promise<Buffer> {
    const out = Buffer.alloc(length);
    let written = 0;
    let skip = offset;
    for (const extent of extents) {
      if (written >= length) break;
      if (skip >= extent.length) {
        skip -= extent.length;
        continue;
      }
      const take = Math.min(extent.length - skip, length - written);
      (await this.read(extent.position + skip, take)).copy(out, written);
      written += take;
      skip = 0;
    }
    if (written !== length) throw new Error('file shorter than its extents');
    return out;
  }
}

const tagOf = (buffer: Buffer): number => buffer.readUInt16LE(0);

const u64 = (buffer: Buffer, offset: number): number => {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('too large');
  return Number(value);
};

interface Volume {
  reader: Reader;
  partitionStart: number;
  blockSize: number;
}

interface Icb {
  lbn: number;
}

/** A file entry's extents, and its length. */
async function fileExtents(volume: Volume, icb: Icb): Promise<{ extents: Extent[]; size: number; embedded: Buffer | null }> {
  const position = (volume.partitionStart + icb.lbn) * volume.blockSize;
  const entry = await volume.reader.read(position, volume.blockSize);
  const tag = tagOf(entry);
  if (tag !== TAG.fileEntry && tag !== TAG.extendedFileEntry) throw new Error(`not a file entry (${tag})`);

  const extended = tag === TAG.extendedFileEntry;
  const size = u64(entry, 56);
  const lengthEa = entry.readUInt32LE(extended ? 208 : 168);
  const lengthAd = entry.readUInt32LE(extended ? 212 : 172);
  const adStart = (extended ? 216 : 176) + lengthEa;
  const flags = entry.readUInt16LE(16 + 18) & 0x7;
  const ads = entry.subarray(adStart, adStart + lengthAd);

  if (flags === 3) return { extents: [], size, embedded: ads.subarray(0, size) };

  const extents: Extent[] = [];
  const step = flags === 0 ? 8 : flags === 1 ? 16 : 0;
  if (step === 0) throw new Error('extended allocation descriptors are not read');
  for (let i = 0; i + step <= ads.length; i += step) {
    const raw = ads.readUInt32LE(i);
    const length = raw & 0x3fffffff;
    const type = raw >>> 30;
    if (length === 0) break;
    // Type 3 continues the list elsewhere; install media never needs it.
    if (type === 3) throw new Error('continued allocation descriptors are not read');
    const lbn = ads.readUInt32LE(i + 4);
    // Types 1 and 2 are allocated-but-unrecorded space, which reads as zeros.
    extents.push({ position: (volume.partitionStart + lbn) * volume.blockSize, length });
  }
  return { extents, size, embedded: null };
}

/** The entries of a directory: name, ICB, and whether it is one. */
async function listDirectory(volume: Volume, icb: Icb) {
  const { extents, size, embedded } = await fileExtents(volume, icb);
  const data = embedded ?? (await volume.reader.readExtents(extents, 0, size));
  const entries: { name: string; icb: Icb; directory: boolean }[] = [];
  let offset = 0;
  while (offset + 38 <= data.length) {
    if (tagOf(data.subarray(offset)) !== TAG.fileIdentifier) break;
    const characteristics = data[offset + 18]!;
    const lengthFi = data[offset + 19]!;
    const lbn = data.readUInt32LE(offset + 20 + 4);
    const lengthIu = data.readUInt16LE(offset + 36);
    const nameStart = offset + 38 + lengthIu;
    const raw = data.subarray(nameStart, nameStart + lengthFi);
    const isParent = (characteristics & 0x08) !== 0;
    if (!isParent && raw.length > 0) {
      const compression = raw[0];
      let name = '';
      if (compression === 8) name = raw.subarray(1).toString('latin1');
      else if (compression === 16) {
        for (let i = 1; i + 1 < raw.length; i += 2) name += String.fromCharCode(raw.readUInt16BE(i));
      }
      entries.push({ name, icb: { lbn }, directory: (characteristics & 0x02) !== 0 });
    }
    offset += 4 * Math.ceil((38 + lengthIu + lengthFi) / 4);
  }
  return entries;
}

async function openVolume(reader: Reader): Promise<{ volume: Volume; root: Icb }> {
  const anchor = await reader.read(256 * SECTOR, SECTOR);
  if (tagOf(anchor) !== TAG.anchor) throw new Error('no UDF anchor');
  const vdsLength = anchor.readUInt32LE(16);
  const vdsLocation = anchor.readUInt32LE(20);

  let partitionStart: number | null = null;
  let blockSize = SECTOR;
  let fileSetLbn: number | null = null;
  for (let i = 0; i < Math.ceil(vdsLength / SECTOR); i += 1) {
    const d = await reader.read((vdsLocation + i) * SECTOR, SECTOR);
    const tag = tagOf(d);
    if (tag === TAG.partition) partitionStart = d.readUInt32LE(188);
    if (tag === TAG.logicalVolume) {
      blockSize = d.readUInt32LE(212);
      // LogicalVolumeContentsUse: a long_ad to the File Set Descriptor.
      fileSetLbn = d.readUInt32LE(248 + 4);
      // A metadata partition (UDF 2.50) is a type 2 partition map; not read.
      const mapTableLength = d.readUInt32LE(264);
      const maps = d.subarray(440, 440 + mapTableLength);
      if (maps.length > 0 && maps[0] !== 1) throw new Error('only type 1 partition maps are read');
    }
    if (tag === TAG.terminating) break;
  }
  if (partitionStart === null || fileSetLbn === null) throw new Error('incomplete UDF volume');
  if (blockSize !== SECTOR) throw new Error('unexpected UDF block size');

  const volume = { reader, partitionStart, blockSize };
  const fileSet = await reader.read((partitionStart + fileSetLbn) * blockSize, blockSize);
  if (tagOf(fileSet) !== TAG.fileSet) throw new Error('no file set descriptor');
  // Root directory ICB: a long_ad at offset 400.
  return { volume, root: { lbn: fileSet.readUInt32LE(400 + 4) } };
}

/** Parse the image list out of the WIM's XML. Exported for tests. */
export function parseWimXml(text: string): WindowsImage[] {
  const images: WindowsImage[] = [];
  const field = (block: string, tag: string): string | null => {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block);
    return m ? decodeEntities(m[1]!.trim()) : null;
  };
  for (const match of text.matchAll(/<IMAGE\s+INDEX="(\d+)"[^>]*>([\s\S]*?)<\/IMAGE>/g)) {
    const block = match[2]!;
    const name = field(block, 'NAME');
    if (!name) continue;
    const arch = field(block, 'ARCH');
    const languages = [...block.matchAll(/<LANGUAGE>([^<]+)<\/LANGUAGE>/g)].map((m) => m[1]!.trim());
    images.push({
      index: Number(match[1]),
      name,
      displayName: field(block, 'DISPLAYNAME'),
      editionId: field(block, 'EDITIONID'),
      architecture: arch === '9' ? 'x64' : arch === '12' ? 'arm64' : arch === '0' ? 'x86' : arch,
      languages: [...new Set(languages)],
    });
  }
  return images.sort((a, b) => a.index - b.index);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The largest WIM XML Velnox will read. Real ones are tens of kilobytes. */
const MAX_XML_BYTES = 8 * 1024 * 1024;

/**
 * The editions in a Windows install ISO, or `null` when this is not one or it
 * cannot be read with confidence.
 */
export async function readWindowsImages(isoPath: string): Promise<WindowsImage[] | null> {
  const handle = await open(isoPath, 'r');
  try {
    const reader = new Reader(handle);
    const { volume, root } = await openVolume(reader);
    const top = await listDirectory(volume, root);
    const sources = top.find((e) => e.directory && e.name.toLowerCase() === 'sources');
    if (!sources) return null;
    const inside = await listDirectory(volume, sources.icb);
    const image = inside.find((e) => !e.directory && /^install\.(wim|esd)$/i.test(e.name));
    if (!image) return null;

    const { extents, size } = await fileExtents(volume, image.icb);
    const header = await reader.readExtents(extents, 0, Math.min(208, size));
    if (header.subarray(0, 8).toString('latin1') !== 'MSWIM\0\0\0') return null;
    // The XML resource header: 7 bytes of stored size, a flags byte, the offset, the original size.
    const xmlSize = Number(header.readBigUInt64LE(72) & 0x00ffffffffffffffn);
    const xmlOffset = u64(header, 80);
    if (xmlSize <= 2 || xmlSize > MAX_XML_BYTES || xmlOffset + xmlSize > size) return null;
    const raw = await reader.readExtents(extents, xmlOffset, xmlSize);
    const text = (raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2) : raw).toString('utf16le');
    const images = parseWimXml(text);
    return images.length > 0 ? images : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
