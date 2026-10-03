import { z } from 'zod';

/**
 * Autoconfig templates: what a VM is built from (Phase 5B).
 *
 * Here because three read it. The API validates a template when it is saved,
 * the worker turns one into an Autounattend.xml or a cloud-init document, and
 * the web offers exactly the choices the other two accept. A list of keyboards
 * the form offers and the generator does not know is a VM that installs with the
 * wrong one.
 *
 * **What is not in here: secrets.** A template's settings are stored as plain
 * JSON and returned by the API. Passwords and product keys live in the secret
 * store, and the settings only say *how* a password is decided — generated for
 * each VM, fixed on the template, or (Linux) none at all. See ADR-039.
 */

// ---------------------------------------------------------------------------
// Families, visibility, delivery
// ---------------------------------------------------------------------------

export const TEMPLATE_OS_FAMILIES = ['WINDOWS', 'LINUX'] as const;
export type TemplateOsFamily = (typeof TEMPLATE_OS_FAMILIES)[number];

/**
 * Who else may use a template.
 *
 * `SHARED` on an MSP template offers it to every tenant; on a tenant template
 * it means nothing more than `PRIVATE`, because a tenant template is never
 * offered outside its tenant. `PRIVATE` on an MSP template keeps it to MSP
 * staff.
 */
export const TEMPLATE_VISIBILITIES = ['SHARED', 'PRIVATE'] as const;
export type TemplateVisibility = (typeof TEMPLATE_VISIBILITIES)[number];

/**
 * How the credentials of a finished VM reach the person who asked for it.
 *
 * Never in a mail body. `VELNOX_ONLY` mails a link, and revealing the passwords
 * is an audited action in Velnox. `ENCRYPTED_PDF` attaches an AES-256 PDF whose
 * password is never in the same mail.
 */
export const CREDENTIAL_DELIVERIES = ['VELNOX_ONLY', 'ENCRYPTED_PDF'] as const;
export type CredentialDelivery = (typeof CREDENTIAL_DELIVERIES)[number];

/** Where an encrypted PDF's password comes from. */
export const PDF_PASSWORD_SOURCES = ['SHOWN_ONCE', 'TEMPLATE'] as const;
export type PdfPasswordSource = (typeof PDF_PASSWORD_SOURCES)[number];

/**
 * How one account's password is decided.
 *
 * `GENERATE` is the default and the recommendation: a fresh random password per
 * VM, so one leaked record opens one machine. `FIXED` takes the password stored
 * on the template. `NONE` is Linux only — a key-only account.
 */
export const PASSWORD_MODES = ['GENERATE', 'FIXED', 'NONE'] as const;
export type PasswordMode = (typeof PASSWORD_MODES)[number];

// ---------------------------------------------------------------------------
// Catalogues the form offers and the generators accept
// ---------------------------------------------------------------------------

/**
 * Windows display and format languages.
 *
 * `UILanguage` must be a language pack the ISO carries; Setup stops and asks
 * when it is not. The list is the languages Microsoft ships as full ISOs that
 * an MSP in this market is likely to hold. A tag outside it is refused rather
 * than passed through, because the failure is a VM waiting at a prompt.
 */
export const WINDOWS_LANGUAGES = [
  'en-US',
  'en-GB',
  'nl-NL',
  'de-DE',
  'fr-FR',
  'fr-BE',
  'nl-BE',
  'es-ES',
  'it-IT',
  'pt-PT',
  'pl-PL',
  'sv-SE',
  'da-DK',
  'nb-NO',
  'fi-FI',
] as const;
export type WindowsLanguage = (typeof WINDOWS_LANGUAGES)[number];

/**
 * Windows keyboard layouts, as `InputLocale` values: language id, colon,
 * keyboard layout id.
 *
 * The reason there are four locale fields instead of one: collapsing them is how
 * a Dutch installation ends up with a Dutch keyboard, which Dutch operators
 * almost never type on. `0413:00020409` is Dutch input on the US-International
 * layout — what most of them actually use.
 */
export const WINDOWS_KEYBOARDS = [
  { id: '0409:00020409', layout: 'US-International' },
  { id: '0413:00020409', layout: 'US-International (Dutch input)' },
  { id: '0409:00000409', layout: 'US' },
  { id: '0413:00000413', layout: 'Dutch' },
  { id: '0813:00000813', layout: 'Belgian (Period)' },
  { id: '080c:0000080c', layout: 'Belgian French' },
  { id: '0809:00000809', layout: 'United Kingdom' },
  { id: '0407:00000407', layout: 'German' },
  { id: '040c:0000040c', layout: 'French' },
  { id: '0410:00000410', layout: 'Italian' },
  { id: '040a:0000040a', layout: 'Spanish' },
] as const;
export type WindowsKeyboard = (typeof WINDOWS_KEYBOARDS)[number]['id'];

/**
 * Windows time zones by their Windows names, with the IANA zone each one is.
 *
 * Windows and Linux name zones differently; the pairing is here so a Windows
 * and a Linux template for the same customer can be set the same way.
 */
export const WINDOWS_TIME_ZONES = [
  { id: 'W. Europe Standard Time', iana: 'Europe/Amsterdam' },
  { id: 'Romance Standard Time', iana: 'Europe/Brussels' },
  { id: 'Central Europe Standard Time', iana: 'Europe/Prague' },
  { id: 'GMT Standard Time', iana: 'Europe/London' },
  { id: 'FLE Standard Time', iana: 'Europe/Helsinki' },
  { id: 'UTC', iana: 'UTC' },
  { id: 'Eastern Standard Time', iana: 'America/New_York' },
  { id: 'Central Standard Time', iana: 'America/Chicago' },
  { id: 'Pacific Standard Time', iana: 'America/Los_Angeles' },
] as const;
export type WindowsTimeZone = (typeof WINDOWS_TIME_ZONES)[number]['id'];

/** Linux locales offered, all UTF-8. */
export const LINUX_LOCALES = [
  'en_US.UTF-8',
  'en_GB.UTF-8',
  'nl_NL.UTF-8',
  'nl_BE.UTF-8',
  'de_DE.UTF-8',
  'fr_FR.UTF-8',
  'fr_BE.UTF-8',
  'es_ES.UTF-8',
  'it_IT.UTF-8',
  'C.UTF-8',
] as const;
export type LinuxLocale = (typeof LINUX_LOCALES)[number];

/** Linux console keyboards, as the layout and variant `keyboard-configuration` takes. */
export const LINUX_KEYBOARDS = [
  { layout: 'us', variant: 'intl', label: 'US-International' },
  { layout: 'us', variant: '', label: 'US' },
  { layout: 'nl', variant: '', label: 'Dutch' },
  { layout: 'be', variant: '', label: 'Belgian' },
  { layout: 'gb', variant: '', label: 'United Kingdom' },
  { layout: 'de', variant: '', label: 'German' },
  { layout: 'fr', variant: '', label: 'French' },
] as const;

export const LINUX_DISTRIBUTIONS = ['UBUNTU', 'DEBIAN'] as const;
export type LinuxDistribution = (typeof LINUX_DISTRIBUTIONS)[number];

/**
 * The mirror Velnox recommends, per distribution — stated, not benchmarked.
 *
 * Debian: the CDN, which resolves to something near the VM and is never stale,
 * and which beats a hand-picked country mirror almost everywhere. Ubuntu: the
 * official geo-selecting form. A fixed national mirror is offered as a choice,
 * never as the default, because it is a single point of failure the CDN is not.
 */
export const RECOMMENDED_MIRRORS: Record<LinuxDistribution, string> = {
  DEBIAN: 'http://deb.debian.org/debian',
  UBUNTU: 'mirror://mirrors.ubuntu.com/mirrors.txt',
};

export const ALTERNATIVE_MIRRORS: Record<LinuxDistribution, readonly string[]> = {
  DEBIAN: ['http://ftp.nl.debian.org/debian'],
  UBUNTU: ['http://nl.archive.ubuntu.com/ubuntu'],
};

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** A Windows or Linux account name: short, and nothing a shell or XML would read twice. */
const accountName = z
  .string()
  .regex(/^[a-z_][a-z0-9_-]{0,31}$/i, 'Letters, digits, dashes and underscores; 32 at most');

/** Names Windows reserves, refused as local account names. */
const WINDOWS_RESERVED_ACCOUNTS = new Set([
  'administrator',
  'guest',
  'defaultaccount',
  'wdagutilityaccount',
  'system',
]);

const LINUX_RESERVED_ACCOUNTS = new Set([
  'root',
  'daemon',
  'bin',
  'sys',
  'sync',
  'nobody',
  'ubuntu',
  'debian',
]);

const passwordMode = z.enum(PASSWORD_MODES);

/** An OpenSSH public key, one line. The comment is optional and free text. */
export const SSH_PUBLIC_KEY =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]{0,200})?$/;

const hardware = z.object({
  cores: z.number().int().min(1).max(128).default(2),
  memoryMb: z
    .number()
    .int()
    .min(512)
    .max(4 * 1024 * 1024)
    .default(4096),
  diskGb: z
    .number()
    .int()
    .min(4)
    .max(64 * 1024)
    .default(64),
  /**
   * Proxmox's own default since 8.0. `host` is faster and pins the VM to CPUs
   * like the one it was created on, which breaks live migration in a mixed
   * cluster — so it is a choice, not the default.
   */
  cpuType: z.enum(['x86-64-v2-AES', 'host']).default('x86-64-v2-AES'),
  startAfterCreate: z.boolean().default(true),
});
export type TemplateHardware = z.infer<typeof hardware>;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const windowsAccount = z.object({
  name: accountName.refine((n) => !WINDOWS_RESERVED_ACCOUNTS.has(n.toLowerCase()), {
    message: 'That name is reserved by Windows',
  }),
  displayName: z.string().trim().max(64).default(''),
  administrator: z.boolean().default(false),
  password: passwordMode.exclude(['NONE']).default('GENERATE'),
});

export const windowsTemplateSchema = z
  .object({
    family: z.literal('WINDOWS'),
    /** The installer, by its library filename. */
    isoFilename: z.string().min(1).max(200),
    /**
     * The edition, by the name in the ISO's image list — `Windows 11 Pro`,
     * `Windows Server 2025 Standard (Desktop Experience)`. Setup is steered by
     * `/IMAGE/NAME`, and the name is checked against the ISO before anything is
     * created, because a name that is not there installs the first edition
     * instead, silently.
     */
    imageName: z.string().trim().min(1).max(200),
    /** The VirtIO drivers ISO, by library filename. Needed for either switch below. */
    virtioIsoFilename: z.string().min(1).max(200).nullable().default(null),
    /** Storage and network drivers during Setup, and the rest after. */
    virtio: z.boolean().default(true),
    /** QEMU Guest Agent, installed at first logon. Velnox uses it to see the install finish. */
    guestAgent: z.boolean().default(true),
    /** GPT is recommended everywhere it is offered: UEFI, Secure Boot, TPM, disks past 2 TB. */
    diskLayout: z.enum(['GPT', 'MBR']).default('GPT'),
    /** A product key is stored as a secret; the settings only say whether there is one. */
    hasProductKey: z.boolean().default(false),
    locale: z
      .object({
        uiLanguage: z.enum(WINDOWS_LANGUAGES).default('en-US'),
        systemLocale: z.enum(WINDOWS_LANGUAGES).default('en-US'),
        userLocale: z.enum(WINDOWS_LANGUAGES).default('en-US'),
        inputLocale: z
          .enum(WINDOWS_KEYBOARDS.map((k) => k.id) as [WindowsKeyboard, ...WindowsKeyboard[]])
          .default('0409:00020409'),
        timeZone: z
          .enum(WINDOWS_TIME_ZONES.map((t) => t.id) as [WindowsTimeZone, ...WindowsTimeZone[]])
          .default('W. Europe Standard Time'),
      })
      .default({}),
    /** Windows Server always requires it; desktop editions get it set and disabled. */
    administratorPassword: passwordMode.exclude(['NONE']).default('GENERATE'),
    accounts: z.array(windowsAccount).max(10).default([]),
    workgroup: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,15}$/, 'Up to 15 letters, digits and dashes')
      .default('WORKGROUP'),
    rdp: z.boolean().default(false),
    powerPlan: z.enum(['HIGH_PERFORMANCE', 'BALANCED']).default('HIGH_PERFORMANCE'),
    hibernation: z.boolean().default(false),
    /**
     * `DEFERRED` gets a VM ready in minutes and updates it afterwards;
     * `DURING_SETUP` lets Setup fetch updates first, which can take an hour.
     */
    windowsUpdate: z.enum(['DEFERRED', 'DURING_SETUP']).default('DEFERRED'),
    hardware: hardware.default({}),
  })
  .superRefine((value, ctx) => {
    if ((value.virtio || value.guestAgent) && !value.virtioIsoFilename) {
      ctx.addIssue({
        code: 'custom',
        path: ['virtioIsoFilename'],
        message: 'VirtIO drivers and the guest agent both install from the VirtIO ISO',
      });
    }
    const names = value.accounts.map((a) => a.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', path: ['accounts'], message: 'Account names repeat' });
    }
    // Windows 11 refuses to install without UEFI and Secure Boot, and MBR means
    // BIOS. The VM would stop at "This PC can't run Windows 11".
    if (value.diskLayout === 'MBR' && /windows\s*11/i.test(value.imageName)) {
      ctx.addIssue({
        code: 'custom',
        path: ['diskLayout'],
        message: 'Windows 11 installs on GPT only',
      });
    }
    // A desktop edition's built-in Administrator is switched off after the first
    // logon, so somebody else has to be able to administer it.
    if (!/server/i.test(value.imageName) && !value.accounts.some((a) => a.administrator)) {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts'],
        message: 'A desktop edition needs at least one administrator account',
      });
    }
  });
export type WindowsTemplate = z.infer<typeof windowsTemplateSchema>;

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

const linuxUser = z.object({
  name: accountName.refine((n) => !LINUX_RESERVED_ACCOUNTS.has(n.toLowerCase()), {
    message: 'That name is taken by the system or the image',
  }),
  /** Extra accounts are sudo-capable users, never additional roots. */
  sudo: z.boolean().default(true),
  sshKeys: z
    .array(z.string().trim().regex(SSH_PUBLIC_KEY, 'An OpenSSH public key'))
    .max(20)
    .default([]),
  password: passwordMode.default('NONE'),
});

export const linuxTemplateSchema = z
  .object({
    family: z.literal('LINUX'),
    distribution: z.enum(LINUX_DISTRIBUTIONS),
    /** The cloud image, by its library filename. */
    imageFilename: z.string().min(1).max(200),
    locale: z.enum(LINUX_LOCALES).default('en_US.UTF-8'),
    keyboard: z
      .object({
        layout: z.string().regex(/^[a-z]{2,8}$/),
        variant: z.string().regex(/^[a-z0-9_-]{0,16}$/),
      })
      .default({ layout: 'us', variant: 'intl' }),
    timeZone: z
      .string()
      .regex(
        /^(UTC|[A-Z][A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2})$/,
        'An IANA zone such as Europe/Amsterdam',
      )
      .default('Europe/Amsterdam'),
    /** `null` is the recommendation for the distribution. */
    mirror: z
      .string()
      .regex(
        /^(https?|mirror):\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/,
        'An http, https or mirror URL',
      )
      .nullable()
      .default(null),
    aptProxy: z
      .string()
      .regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/, 'http://host:port')
      .nullable()
      .default(null),
    /** A sudo user with a key is the default; see the owner's decision in the roadmap. */
    users: z.array(linuxUser).min(1).max(10),
    root: z
      .object({
        /** Off unless chosen. */
        allowLogin: z.boolean().default(false),
        password: passwordMode.default('NONE'),
      })
      .default({}),
    /**
     * The SSH switch, on by default: the server installed and enabled, keys
     * placed, password authentication off unless turned on here.
     */
    ssh: z
      .object({
        enabled: z.boolean().default(true),
        passwordAuthentication: z.boolean().default(false),
      })
      .default({}),
    guestAgent: z.boolean().default(true),
    unattendedUpgrades: z.boolean().default(true),
    /** Extra packages at first boot, by Debian package name. */
    packages: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9+.-]{1,62}$/, 'A Debian package name'))
      .max(50)
      .default([]),
    swapMb: z.number().int().min(0).max(65536).default(0),
    hardware: hardware.default({ diskGb: 20, memoryMb: 2048 }),
  })
  .superRefine((value, ctx) => {
    const names = value.users.map((u) => u.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', path: ['users'], message: 'User names repeat' });
    }
    // A machine nobody can log on to is a machine that has to be rebuilt.
    const usable = value.users.some(
      (u) => (value.ssh.enabled && u.sshKeys.length > 0) || u.password !== 'NONE',
    );
    if (!usable && !(value.root.allowLogin && value.root.password !== 'NONE')) {
      ctx.addIssue({
        code: 'custom',
        path: ['users'],
        message: 'At least one account needs an SSH key or a password',
      });
    }
    if (value.root.allowLogin && value.root.password === 'NONE' && !value.ssh.enabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['root'],
        message: 'Root login without a password needs SSH and a key',
      });
    }
  });
export type LinuxTemplate = z.infer<typeof linuxTemplateSchema>;

export const templateSettingsSchema = z.union([windowsTemplateSchema, linuxTemplateSchema]);
export type TemplateSettings = WindowsTemplate | LinuxTemplate;

/**
 * The secrets a template can hold, keyed by what they are for.
 *
 * `accounts.<name>` for a Windows account or Linux user set to `FIXED`,
 * `administrator`, `root`, `productKey`, and `pdfPassword`. Stored as one JSON
 * object in the secret store; never returned by the API, only whether each is
 * set.
 */
export type TemplateSecretKey =
  `account:${string}` | 'administrator' | 'root' | 'productKey' | 'pdfPassword';

/** Which secrets a template's settings need present to be usable. */
export function requiredTemplateSecrets(
  settings: TemplateSettings,
  delivery: { credentialDelivery: CredentialDelivery; pdfPasswordSource: PdfPasswordSource },
): TemplateSecretKey[] {
  const keys: TemplateSecretKey[] = [];
  if (settings.family === 'WINDOWS') {
    if (settings.administratorPassword === 'FIXED') keys.push('administrator');
    for (const account of settings.accounts) {
      if (account.password === 'FIXED') keys.push(`account:${account.name}`);
    }
    if (settings.hasProductKey) keys.push('productKey');
  } else {
    if (settings.root.password === 'FIXED') keys.push('root');
    for (const user of settings.users) {
      if (user.password === 'FIXED') keys.push(`account:${user.name}`);
    }
  }
  if (
    delivery.credentialDelivery === 'ENCRYPTED_PDF' &&
    delivery.pdfPasswordSource === 'TEMPLATE'
  ) {
    keys.push('pdfPassword');
  }
  return keys;
}

/**
 * Why a password stored on a template would fail, or null.
 *
 * Windows applies its complexity rule during Setup, and an account whose
 * password breaks it is not created — which is found out when nobody can log
 * on. So the rule is applied here, when the password is typed: twelve
 * characters at least, and three of upper case, lower case, digits and
 * symbols. Linux gets the same, because the same people choose them.
 */
export function passwordProblem(password: string): 'too_short' | 'too_simple' | 'too_long' | null {
  if (password.length < 12) return 'too_short';
  if (password.length > 128) return 'too_long';
  const classes = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  return classes >= 3 ? null : 'too_simple';
}

/**
 * The alphabet generated passwords use.
 *
 * No characters that look alike (0 O, 1 l I), and symbols that sit in the same
 * place on US, US-International, UK and Dutch keyboards — a password is often
 * typed first on a console whose layout is whatever the template set.
 */
const PASSWORD_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PASSWORD_LOWER = 'abcdefghijkmnopqrstuvwxyz';
const PASSWORD_DIGITS = '23456789';
const PASSWORD_SYMBOLS = '-_.+=';

/** A fresh password for one account: 20 characters, every class present. */
export function generatePassword(length = 20): string {
  const all = PASSWORD_UPPER + PASSWORD_LOWER + PASSWORD_DIGITS + PASSWORD_SYMBOLS;
  /** A uniform integer in [0, max), by rejection sampling: no value likelier than another. */
  const below = (max: number): number => {
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % max);
    const word = new Uint32Array(1);
    for (;;) {
      globalThis.crypto.getRandomValues(word);
      if (word[0]! < limit) return word[0]! % max;
    }
  };
  const pick = (alphabet: string): string => alphabet[below(alphabet.length)]!;
  const chars = [
    pick(PASSWORD_UPPER),
    pick(PASSWORD_LOWER),
    pick(PASSWORD_DIGITS),
    pick(PASSWORD_SYMBOLS),
    ...Array.from({ length: Math.max(0, length - 4) }, () => pick(all)),
  ];
  // Fisher–Yates, so the guaranteed classes are not always first.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = below(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/**
 * A Windows product key: five groups of five.
 *
 * Only the shape is checked. Whether Microsoft accepts it is Windows' business,
 * and it will say so at activation rather than at install.
 */
export const PRODUCT_KEY = /^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/;

// ---------------------------------------------------------------------------
// Hostnames and the provisioning request
// ---------------------------------------------------------------------------

/**
 * A hostname without a domain, as the owner asked.
 *
 * 15 characters is Windows' NetBIOS limit, and a Windows name longer than that
 * is silently truncated — two VMs then share a name on the network. Linux
 * allows 63, and gets them.
 */
export function hostnameProblem(name: string, family: TemplateOsFamily): string | null {
  const max = family === 'WINDOWS' ? 15 : 63;
  if (name.length === 0) return 'empty';
  if (name.length > max) return 'too_long';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name)) return 'characters';
  if (/^\d+$/.test(name)) return 'digits_only';
  return null;
}

export const PROVISION_NETWORK_MODES = ['DHCP', 'STATIC'] as const;

export const provisionNetworkSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('DHCP') }),
  z.object({
    mode: z.literal('STATIC'),
    /** `192.0.2.10/24` */
    address: z
      .string()
      .regex(
        /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/,
        'An IPv4 address with prefix, such as 192.0.2.10/24',
      ),
    gateway: z.string().regex(/^(\d{1,3}\.){3}\d{1,3}$/, 'An IPv4 address'),
    dns: z
      .array(z.string().regex(/^(\d{1,3}\.){3}\d{1,3}$/))
      .min(1)
      .max(3),
  }),
]);
export type ProvisionNetwork = z.infer<typeof provisionNetworkSchema>;

/** Proxmox node and storage names, and a bridge. */
const pveName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const provisionRequestSchema = z.object({
  templateId: z.string().uuid(),
  clusterId: z.string().uuid(),
  node: pveName,
  /** Where the VM's disks go. */
  diskStorage: pveName,
  /** Where the installer or cloud image is looked for, and put if missing. */
  mediaStorage: pveName,
  bridge: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,15}$/),
  vlan: z.number().int().min(1).max(4094).nullable().default(null),
  hostname: z.string(),
  network: provisionNetworkSchema.default({ mode: 'DHCP' }),
  /** Whether to mail the person who asked when it finishes. */
  notify: z.boolean().default(true),
});
export type ProvisionRequest = z.infer<typeof provisionRequestSchema>;

// ---------------------------------------------------------------------------
// What the API returns
// ---------------------------------------------------------------------------

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  family: TemplateOsFamily;
  /** The tenant that owns it: the MSP root, or a customer. */
  tenantId: string;
  tenantName: string;
  ownedByMsp: boolean;
  visibility: TemplateVisibility;
  credentialDelivery: CredentialDelivery;
  pdfPasswordSource: PdfPasswordSource;
  clonedFromId: string | null;
  clonedFromName: string | null;
  settings: TemplateSettings;
  /** Which of the secrets the settings call for are stored. Never the values. */
  secretsSet: Partial<Record<TemplateSecretKey, boolean>>;
  /** Secrets the settings need that are not stored: the template cannot be used until they are. */
  secretsMissing: TemplateSecretKey[];
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

export const PROVISIONING_STATES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type ProvisioningState = (typeof PROVISIONING_STATES)[number];

export interface ProvisioningSummary {
  id: string;
  tenantId: string;
  templateId: string | null;
  templateName: string;
  family: TemplateOsFamily;
  clusterId: string | null;
  clusterName: string;
  node: string;
  vmid: number | null;
  hostname: string;
  state: ProvisioningState;
  jobId: string | null;
  /** The job's step while the VM is being built (`check`, `media`, … `notify`); null otherwise. */
  currentStep: string | null;
  /** The job's overall progress while the VM is being built; null otherwise. */
  progressPct: number | null;
  addresses: string[];
  requestedByLabel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  credentialDelivery: CredentialDelivery;
  /** Whether the credentials can still be revealed: they are dropped a while after the VM is handed over. */
  credentialsAvailable: boolean;
  notifiedAt: string | null;
  createdAt: string;
  errorCode: string | null;
  errorParams: Record<string, string | number | boolean | null> | null;
}

/** The accounts of a finished VM, returned only by the audited reveal. */
export interface RevealedCredentials {
  hostname: string;
  accounts: { name: string; password: string | null; administrator: boolean }[];
  /** Until when this reveal's answer may be shown; the page clears it after. */
  expiresAt: string;
}
