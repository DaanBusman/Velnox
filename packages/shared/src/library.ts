/**
 * The ISO library: names, kinds and friendly names.
 *
 * Here rather than in one service because three read it. The API refuses a bad
 * filename when an upload is started, the worker decides what content type a
 * file is pushed as, and the web turns a filename into something a person reads.
 * Rules that disagree between those three are how a file ends up uploaded,
 * accepted, and then refused by Proxmox an hour later.
 */

// ---------------------------------------------------------------------------
// Kinds and filenames
// ---------------------------------------------------------------------------

export const LIBRARY_ITEM_KINDS = ['ISO', 'DISK_IMAGE'] as const;
export type LibraryItemKind = (typeof LIBRARY_ITEM_KINDS)[number];

export const LIBRARY_ITEM_STATES = ['RECEIVING', 'VERIFYING', 'READY', 'FAILED'] as const;
export type LibraryItemState = (typeof LIBRARY_ITEM_STATES)[number];

export const LIBRARY_ITEM_SOURCES = ['UPLOAD', 'URL', 'CLUSTER'] as const;
export type LibraryItemSource = (typeof LIBRARY_ITEM_SOURCES)[number];

/**
 * What a library filename may look like.
 *
 * Proxmox normalises an uploaded filename by replacing anything outside
 * `[-a-zA-Z0-9_.]` with an underscore. Accepting a wider set here would mean the
 * file lands on the node under a name Velnox never recorded, and every later
 * lookup — "is it on that node?" — misses it. So the rule is Proxmox's rule,
 * plus: it starts with a letter or digit, it has no `..`, and it is short enough
 * to fit on every filesystem Proxmox storage runs on.
 */
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const ISO_EXTENSIONS = ['.iso'] as const;
/**
 * Disk images Proxmox's `import` content type accepts, plus `.img`.
 *
 * `.img` is what Ubuntu calls its cloud images, which are qcow2 inside. It is
 * accepted into the library under its own name and pushed under a `.qcow2` or
 * `.raw` one, decided by reading the file rather than trusting the extension —
 * see {@link importFilename}.
 */
export const DISK_IMAGE_EXTENSIONS = ['.qcow2', '.raw', '.img'] as const;

export function isValidLibraryFilename(name: string): boolean {
  return FILENAME.test(name) && !name.includes('..') && !name.endsWith('.');
}

/** The kind a filename declares, or null when it is neither. */
export function kindForFilename(name: string): LibraryItemKind | null {
  const lower = name.toLowerCase();
  if (ISO_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'ISO';
  if (DISK_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'DISK_IMAGE';
  return null;
}

/** The Proxmox content type a kind is stored as. */
export const contentTypeFor = (kind: LibraryItemKind): 'iso' | 'import' =>
  kind === 'ISO' ? 'iso' : 'import';

/**
 * The filename a disk image is pushed under.
 *
 * Proxmox's `import` content accepts `.qcow2`, `.raw`, `.vmdk` and `.ova`, and
 * uses the extension to decide how to read the file. An Ubuntu `.img` is qcow2,
 * so it goes up as `.qcow2`; a file whose first bytes are not the qcow2 magic is
 * raw. The format comes from the bytes, because an extension is only a claim.
 */
export function importFilename(name: string, format: 'qcow2' | 'raw'): string {
  const base = name.replace(/\.(img|qcow2|raw)$/i, '');
  return `${base}.${format}`;
}

/** A Proxmox volume id for a file on a storage. */
export const volumeId = (storage: string, kind: LibraryItemKind, filename: string): string =>
  `${storage}:${contentTypeFor(kind)}/${filename}`;

// ---------------------------------------------------------------------------
// Friendly names
// ---------------------------------------------------------------------------

/**
 * Descriptors a friendly name can carry. Keys, not words: the interface
 * translates them, the parser only recognises them.
 */
export const LIBRARY_VARIANTS = [
  'server',
  'desktop',
  'netinst',
  'live',
  'cloudImage',
  'evaluation',
  'drivers',
  'businessEditions',
  'consumerEditions',
] as const;
export type LibraryVariant = (typeof LIBRARY_VARIANTS)[number];

export interface FriendlyName {
  /**
   * The product and its version, as the vendor writes them. Never translated —
   * "Windows 11 Version 25H2" is a product name in every language.
   */
  title: string;
  variants: LibraryVariant[];
  /**
   * A BCP 47 tag. The interface names it in the reader's own language, which is
   * how `Windows11_25H2_Dutch` reads "Dutch" to one person and "Nederlands" to
   * the next.
   */
  language: string | null;
  arch: string | null;
  /**
   * False when nothing was recognised and the title is the bare filename. The
   * interface says so, because a parser is a heuristic and a confident wrong
   * label is worse than an honest raw one.
   */
  recognised: boolean;
}

/**
 * Microsoft names its ISOs with the language in English, run together.
 *
 * Tags carry a region only where the region changes the language an installer
 * speaks — `pt-BR` against `pt-PT`, `en-US` against `en-GB`. "Dutch" is `nl`,
 * which a reader sees as "Dutch" or "Nederlands" rather than "Dutch
 * (Netherlands)".
 */
const LANGUAGE_WORDS: Record<string, string> = {
  arabic: 'ar',
  brazilianportuguese: 'pt-BR',
  bulgarian: 'bg',
  chinesesimplified: 'zh-Hans',
  chinesetraditional: 'zh-Hant',
  croatian: 'hr',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en-US',
  englishinternational: 'en-GB',
  estonian: 'et',
  finnish: 'fi',
  french: 'fr',
  frenchcanadian: 'fr-CA',
  german: 'de',
  greek: 'el',
  hebrew: 'he',
  hungarian: 'hu',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  latvian: 'lv',
  lithuanian: 'lt',
  norwegian: 'nb',
  polish: 'pl',
  portuguese: 'pt-PT',
  romanian: 'ro',
  russian: 'ru',
  serbianlatin: 'sr-Latn',
  slovak: 'sk',
  slovenian: 'sl',
  spanish: 'es',
  spanishmexico: 'es-MX',
  swedish: 'sv',
  thai: 'th',
  turkish: 'tr',
  ukrainian: 'uk',
};

/** `en-us`, `nl-nl`, `pt-br` as they appear in Microsoft's volume-licence names. */
const LOCALE_TOKEN = /^([a-z]{2})-([a-z]{2})$/i;

/** Regions that change the language, as above. Any other region is dropped. */
const MEANINGFUL_REGIONS = new Set([
  'en-us',
  'en-gb',
  'pt-br',
  'pt-pt',
  'fr-ca',
  'es-mx',
  'zh-cn',
  'zh-tw',
]);

function languageFromLocale(token: string): string | null {
  const match = LOCALE_TOKEN.exec(token);
  if (!match) return null;
  const lower = token.toLowerCase();
  if (lower === 'zh-cn') return 'zh-Hans';
  if (lower === 'zh-tw') return 'zh-Hant';
  if (MEANINGFUL_REGIONS.has(lower)) return `${match[1]!.toLowerCase()}-${match[2]!.toUpperCase()}`;
  return match[1]!.toLowerCase();
}

const ARCH_WORDS: Record<string, string> = {
  x64: 'x64',
  x64fre: 'x64',
  amd64: 'amd64',
  x86_64: 'x86_64',
  arm64: 'arm64',
  aarch64: 'arm64',
  i386: 'i386',
  x86: 'x86',
};

/** Windows Server editions by the build number Microsoft's evaluation ISOs start with. */
const SERVER_BUILDS: Record<string, string> = {
  '14393': 'Windows Server 2016',
  '17763': 'Windows Server 2019',
  '20348': 'Windows Server 2022',
  '26100': 'Windows Server 2025',
};

const UBUNTU_CODENAMES: Record<string, string> = {
  focal: '20.04',
  jammy: '22.04',
  noble: '24.04',
  oracular: '24.10',
  plucky: '25.04',
  questing: '25.10',
};

const DEBIAN_CODENAMES: Record<string, string> = {
  '11': 'bullseye',
  '12': 'bookworm',
  '13': 'trixie',
  '14': 'forky',
};

const stripExtension = (name: string): string => name.replace(/\.(iso|img|qcow2|raw)$/i, '');

/** Ubuntu's LTS rule: an even year's April release. */
const ubuntuTitle = (version: string): string => {
  const [year, month] = version.split('.');
  const lts = month === '04' && Number(year) % 2 === 0;
  return `Ubuntu ${version}${lts ? ' LTS' : ''}`;
};

/**
 * Turn a filename into something a person reads.
 *
 * Deliberately a list of the naming schemes that actually occur — Microsoft's
 * consumer and volume-licence names, its evaluation builds, Ubuntu, Debian,
 * Proxmox, VirtIO — rather than a general tokenizer, because a general one
 * produces confident nonsense for anything it half-recognises. What matches
 * none of them keeps its filename and says it was not recognised.
 */
export function parseFriendlyName(filename: string): FriendlyName {
  const base = stripExtension(filename);
  /*
   * Underscores first, hyphens second. `en-us` is one token and a locale;
   * split on every hyphen and it becomes "en" and "us", which is how the first
   * version lost the language of every Microsoft evaluation ISO.
   */
  const tokens = base.split(/[_\s]+/).filter(Boolean);
  const parts = tokens.flatMap((token) => token.split('-')).filter(Boolean);

  const language = (() => {
    for (const token of tokens) {
      const locale = languageFromLocale(token);
      if (locale) return locale;
    }
    for (const part of parts) {
      const word = LANGUAGE_WORDS[part.toLowerCase()];
      if (word) return word;
    }
    return null;
  })();

  const arch = (() => {
    // Before the token loop: splitting on underscores turns x86_64 into "x86".
    if (/x86_64/i.test(base)) return 'x86_64';
    for (const part of parts) {
      const stripped = part.toLowerCase().replace(/v\d+$/, ''); // Win11_…_x64v1
      if (ARCH_WORDS[stripped]) return ARCH_WORDS[stripped];
    }
    return null;
  })();

  const result = (title: string, variants: LibraryVariant[] = []): FriendlyName => ({
    title,
    variants,
    language,
    arch,
    recognised: true,
  });

  // --- Windows 10/11, consumer download names: Win11_25H2_Dutch_x64v1 ---------
  const consumer = /^win(?:dows)?[-_ ]?(1[01])[_-](\d{2}H\d)(?:[_-]|$)/i.exec(base);
  if (consumer) return result(`Windows ${consumer[1]} Version ${consumer[2]!.toUpperCase()}`);

  // --- Windows, volume-licence names: nl-nl_windows_11_business_editions_version_24h2_x64_dvd
  const vl = /windows_(1[01])_(business|consumer)_editions?_version_(\d{2}h\d)/i.exec(base);
  if (vl) {
    return result(`Windows ${vl[1]} Version ${vl[3]!.toUpperCase()}`, [
      vl[2]!.toLowerCase() === 'business' ? 'businessEditions' : 'consumerEditions',
    ]);
  }
  const vlPlain = /windows_(1[01])(?:_version_(\d{2}h\d))?/i.exec(base);
  if (vlPlain && /^[a-z]{2}-[a-z]{2}_windows_/i.test(base)) {
    return result(
      vlPlain[2]
        ? `Windows ${vlPlain[1]} Version ${vlPlain[2].toUpperCase()}`
        : `Windows ${vlPlain[1]}`,
    );
  }

  // --- Windows Server, volume-licence: en-us_windows_server_2025_x64_dvd -----
  const serverVl = /windows_server_(20\d\d)(?:_r2)?/i.exec(base);
  if (serverVl) {
    const r2 = /windows_server_20\d\d_r2/i.test(base) ? ' R2' : '';
    return result(`Windows Server ${serverVl[1]}${r2}`);
  }

  // --- Windows Server evaluation: 26100.1742.…_SERVER_EVAL_x64FRE_en-us ------
  if (/SERVER_EVAL/i.test(base)) {
    const build = /^(\d{5})\./.exec(base);
    const title = build && SERVER_BUILDS[build[1]!] ? SERVER_BUILDS[build[1]!]! : 'Windows Server';
    return result(title, ['evaluation']);
  }

  // --- VirtIO drivers: virtio-win-0.1.271 --------------------------------------
  const virtio = /^virtio-win(?:-(\d+(?:\.\d+)+))?/i.exec(base);
  if (virtio) return result(`VirtIO-win${virtio[1] ? ` ${virtio[1]}` : ''}`, ['drivers']);

  // --- Proxmox: proxmox-ve_9.0-1, proxmox-backup-server_4.0-1 ----------------
  const proxmox = /^proxmox-(ve|backup-server|mail-gateway)_(\d+\.\d+)/i.exec(base);
  if (proxmox) {
    const product = { ve: 'VE', 'backup-server': 'Backup Server', 'mail-gateway': 'Mail Gateway' }[
      proxmox[1]!.toLowerCase()
    ];
    return result(`Proxmox ${product} ${proxmox[2]}`);
  }

  // --- Ubuntu: ubuntu-24.04.3-live-server-amd64, noble-server-cloudimg-amd64 --
  const ubuntu = /^ubuntu-(\d{2}\.\d{2}(?:\.\d+)?)/i.exec(base);
  const ubuntuCodename = /^(focal|jammy|noble|oracular|plucky|questing)-/i.exec(base);
  if (ubuntu || ubuntuCodename) {
    const version = ubuntu ? ubuntu[1]! : UBUNTU_CODENAMES[ubuntuCodename![1]!.toLowerCase()]!;
    const variants: LibraryVariant[] = [];
    if (/cloudimg/i.test(base)) variants.push('cloudImage');
    else {
      if (/live/i.test(base)) variants.push('live');
      if (/server/i.test(base)) variants.push('server');
      if (/desktop/i.test(base)) variants.push('desktop');
    }
    return result(ubuntuTitle(version), variants);
  }

  // --- Debian: debian-13.1.0-amd64-netinst, debian-12-genericcloud-amd64 ------
  const debian = /^debian-(?:live-)?(\d+)(?:\.(\d+)(?:\.(\d+))?)?/i.exec(base);
  if (debian) {
    const version = [debian[1], debian[2], debian[3]].filter(Boolean).join('.');
    const codename = DEBIAN_CODENAMES[debian[1]!];
    const variants: LibraryVariant[] = [];
    if (/genericcloud|generic-|nocloud/i.test(base)) variants.push('cloudImage');
    if (/netinst/i.test(base)) variants.push('netinst');
    if (/debian-live/i.test(base)) variants.push('live');
    return result(`Debian ${version}${codename ? ` (${codename})` : ''}`, variants);
  }

  return { title: base, variants: [], language, arch, recognised: false };
}

// ---------------------------------------------------------------------------
// Job parameters
//
// Parsed in the API before a job is created and again in the worker before it
// runs, so a malformed request is refused at the door rather than failing on a
// node a minute later.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Proxmox node and storage identifiers. */
const PVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** `storage:iso/name.iso` or `storage:import/name.qcow2`, and nothing looser. */
const VOLID =
  /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}):(iso|import)\/([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/;

export class LibraryParamsError extends Error {
  constructor(readonly field: string) {
    super(`Invalid library job parameter: ${field}`);
    this.name = 'LibraryParamsError';
  }
}

const record = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

const uuid = (input: Record<string, unknown>, field: string): string => {
  const value = input[field];
  if (typeof value !== 'string' || !UUID.test(value)) throw new LibraryParamsError(field);
  return value.toLowerCase();
};

const pveId = (input: Record<string, unknown>, field: string): string => {
  const value = input[field];
  if (typeof value !== 'string' || !PVE_ID.test(value)) throw new LibraryParamsError(field);
  return value;
};

export interface ParsedVolumeId {
  storage: string;
  content: 'iso' | 'import';
  filename: string;
}

export function parseVolumeId(volid: string): ParsedVolumeId | null {
  const match = VOLID.exec(volid);
  if (!match || match[3]!.includes('..')) return null;
  return { storage: match[1]!, content: match[2] as 'iso' | 'import', filename: match[3]! };
}

export interface LibraryItemParams {
  itemId: string;
}

export interface LibraryPushParams {
  itemId: string;
  clusterId: string;
  node: string;
  storage: string;
}

export interface ClusterVolumeParams {
  clusterId: string;
  node: string;
  storage: string;
  volid: string;
}

export interface LibraryPullParams extends ClusterVolumeParams {
  itemId: string;
}

export function parseLibraryItemParams(raw: unknown): LibraryItemParams {
  return { itemId: uuid(record(raw), 'itemId') };
}

export function parseLibraryPushParams(raw: unknown): LibraryPushParams {
  const input = record(raw);
  return {
    itemId: uuid(input, 'itemId'),
    clusterId: uuid(input, 'clusterId'),
    node: pveId(input, 'node'),
    storage: pveId(input, 'storage'),
  };
}

export function parseClusterVolumeParams(raw: unknown): ClusterVolumeParams {
  const input = record(raw);
  const storage = pveId(input, 'storage');
  const volid = input.volid;
  const parsed = typeof volid === 'string' ? parseVolumeId(volid) : null;
  // The volume must be on the storage it claims to be on, or a request could
  // name one storage for the permission check and another for the delete.
  if (!parsed || parsed.storage !== storage) throw new LibraryParamsError('volid');
  return {
    clusterId: uuid(input, 'clusterId'),
    node: pveId(input, 'node'),
    storage,
    volid: volid as string,
  };
}

export function parseLibraryPullParams(raw: unknown): LibraryPullParams {
  return { ...parseClusterVolumeParams(raw), itemId: uuid(record(raw), 'itemId') };
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export const GIB = 1024 ** 3;

export interface LibraryCapacity {
  /** Bytes the library may hold in total, including transfers in progress. */
  ceilingBytes: number;
  /** Bytes held or reserved by items that are not failed. */
  usedBytes: number;
  /** Free bytes on the filesystem the library lives on. */
  diskFreeBytes: number;
  /** Below this, nothing new is accepted. */
  diskFloorBytes: number;
}

export type CapacityRefusal =
  | { code: 'library.full'; params: { ceilingGb: number; usedGb: number; requestedGb: number } }
  | { code: 'library.disk_low'; params: { freeGb: number; floorGb: number; requestedGb: number } };

const gb = (bytes: number): number => Math.round((bytes / GIB) * 10) / 10;

/**
 * May `additionalBytes` more be written?
 *
 * Two limits, and both are named in the refusal. The ceiling is the library's
 * own budget. The floor is the disk's: the library shares it with PostgreSQL and
 * Redis by default, and a full disk there is not a failed upload but an
 * installation that has stopped. `additionalBytes` is what is still to be
 * written, not the file's size — a resumed upload has already written part.
 */
export function checkCapacity(
  capacity: LibraryCapacity,
  additionalBytes: number,
): CapacityRefusal | null {
  if (capacity.usedBytes + additionalBytes > capacity.ceilingBytes) {
    return {
      code: 'library.full',
      params: {
        ceilingGb: gb(capacity.ceilingBytes),
        usedGb: gb(capacity.usedBytes),
        requestedGb: gb(additionalBytes),
      },
    };
  }
  if (capacity.diskFreeBytes - additionalBytes < capacity.diskFloorBytes) {
    return {
      code: 'library.disk_low',
      params: {
        freeGb: gb(capacity.diskFreeBytes),
        floorGb: gb(capacity.diskFloorBytes),
        requestedGb: gb(additionalBytes),
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// What the bytes are
// ---------------------------------------------------------------------------

/** Enough of a file to recognise it: through the first ISO 9660 volume descriptor. */
export const SNIFF_BYTES = 0x8006;

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/**
 * Is this an ISO image, or a qcow2 disk?
 *
 * An ISO has its first volume descriptor at byte 32769: `CD001` for ISO 9660,
 * `BEA01` where a UDF-only image starts its recognition sequence. Windows
 * installation media carries both. qcow2 starts with `QFI` and 0xFB. Anything
 * else offered as a disk image is treated as raw, which Proxmox can import but
 * cannot check — which is why the format is recorded rather than assumed.
 *
 * Checked because an extension is only a claim: an HTML error page saved as
 * `Win11.iso` is the usual way a URL fetch "succeeds" at the wrong thing.
 */
export function sniffLibraryContent(head: Uint8Array): { iso: boolean; qcow2: boolean } {
  const descriptor = head.length >= SNIFF_BYTES ? ascii(head, 0x8001, 5) : '';
  const qcow2 =
    head.length >= 4 &&
    head[0] === 0x51 &&
    head[1] === 0x46 &&
    head[2] === 0x49 &&
    head[3] === 0xfb;
  return { iso: descriptor === 'CD001' || descriptor === 'BEA01', qcow2 };
}

/**
 * A URL as Velnox shows and logs it: without its query string or credentials.
 *
 * Download links are very often signed — Microsoft's ISO links carry an
 * expiring token in the query — and a signed URL is a bearer credential for as
 * long as it lives. The full URL is kept where the worker needs it and nowhere
 * else; every screen, log line and job event gets this.
 */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search ? '?…' : ''}`;
  } catch {
    return '(not a URL)';
  }
}

/**
 * Where a file on a cluster lives, as one key.
 *
 * Shared storage is one place however many nodes can see it, so it is keyed by
 * its name alone; local storage is keyed by node and name. Without the
 * distinction, an ISO on a Ceph or NFS storage appears once per node, and
 * deleting "one" of them deletes all of them.
 */
export const locationKeyFor = (node: string, storage: string, shared: boolean): string =>
  shared ? storage : `${node}/${storage}`;

// ---------------------------------------------------------------------------
// What the API returns
// ---------------------------------------------------------------------------

export interface LibraryItemSummary {
  id: string;
  kind: LibraryItemKind;
  state: LibraryItemState;
  source: LibraryItemSource;
  /** The real filename: what Proxmox calls it and what every log line shows. */
  filename: string;
  sizeBytes: number | null;
  receivedBytes: number;
  sha256: string | null;
  diskFormat: string | null;
  titleOverride: string | null;
  /** A BCP 47 tag, an empty string for "no language", or null for "as parsed". */
  languageOverride: string | null;
  /** Without its query string, which is where a signed link keeps its token. */
  sourceUrl: string | null;
  sourceClusterName: string | null;
  sourceVolid: string | null;
  jobId: string | null;
  createdBy: string | null;
  errorCode: string | null;
  errorParams: Record<string, string | number | boolean | null> | null;
  createdAt: string;
  readyAt: string | null;
}

export interface LibraryCapacitySummary extends LibraryCapacity {
  maxGb: number;
  minFreeGb: number;
}

export interface LibraryListResponse {
  items: LibraryItemSummary[];
  capacity: LibraryCapacitySummary;
}

export interface ClusterFile {
  id: string;
  node: string;
  storage: string;
  shared: boolean;
  volid: string;
  filename: string;
  content: 'iso' | 'import';
  format: string | null;
  sizeBytes: number | null;
  fileCreatedAt: string | null;
  lastSeenAt: string;
  /** The library item with the same name and size, when there is one. */
  libraryItemId: string | null;
}

export interface ClusterFilesResponse {
  sshConfigured: boolean;
  contents: ClusterFile[];
}

export interface ClusterSshStatus {
  configured: boolean;
  username: string | null;
  port: number;
  verifiedAt: string | null;
  nodes: {
    node: string;
    address: string | null;
    fingerprint: string | null;
    keyType: string | null;
  }[];
}

export interface ClusterSshProbe {
  nodes: {
    node: string;
    host: string;
    fingerprint: string | null;
    keyType: string | null;
    error: string | null;
  }[];
}
