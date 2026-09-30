import { withSystemScope, type VelnoxPrismaClient } from '@velnox/db';
import type { CredentialReader } from '../inventory/credentials';
import type { Mailer } from '../mail/mailer';
import { formatWhen, renderRecord } from './record';

/**
 * The mail that says a VM is ready, sent once.
 *
 * **Never a password in it.** The body names the machine and links to it; the
 * record is attached. When the template sends credentials by encrypted PDF, the
 * PDF carries them and its password is not in this mail — it was shown to the
 * requester once in Velnox, or set on the template by an administrator.
 *
 * **Once** is a claim on the row, made before the mail goes: `notifiedAt` is
 * set only if it was empty. A retry of the step, or a second worker, finds it
 * set and sends nothing. If the send then fails, the claim is released so a
 * later attempt may try again.
 */

const SUBJECT = {
  en: (host: string) => `${host} is ready`,
  nl: (host: string) => `${host} is klaar`,
};

const BODY = {
  en: (v: {
    host: string;
    vmid: string;
    cluster: string;
    node: string;
    addresses: string;
    link: string | null;
    credentials: 'velnox' | 'pdf';
    finished: string;
  }) =>
    [
      `${v.host} has been built and has finished installing.`,
      '',
      `VM ${v.vmid} on ${v.node}, cluster ${v.cluster}`,
      `Addresses: ${v.addresses}`,
      `Finished: ${v.finished}`,
      '',
      v.credentials === 'pdf'
        ? 'The accounts and their passwords are in the attached PDF. It is encrypted; its password is not in this mail.'
        : 'The installation record is attached. The passwords are kept in Velnox, where revealing them is recorded.',
      ...(v.link ? ['', v.link] : []),
      '',
      '— Velnox',
    ].join('\n'),
  nl: (v: {
    host: string;
    vmid: string;
    cluster: string;
    node: string;
    addresses: string;
    link: string | null;
    credentials: 'velnox' | 'pdf';
    finished: string;
  }) =>
    [
      `${v.host} is gebouwd en klaar met installeren.`,
      '',
      `VM ${v.vmid} op ${v.node}, cluster ${v.cluster}`,
      `Adressen: ${v.addresses}`,
      `Klaar: ${v.finished}`,
      '',
      v.credentials === 'pdf'
        ? 'De accounts en hun wachtwoorden staan in de bijgevoegde PDF. Die is versleuteld; het wachtwoord ervan staat niet in deze mail.'
        : 'Het installatieverslag is bijgevoegd. De wachtwoorden worden in Velnox bewaard, waar het tonen ervan wordt vastgelegd.',
      ...(v.link ? ['', v.link] : []),
      '',
      '— Velnox',
    ].join('\n'),
};

export async function notifyProvisioned(input: {
  prisma: VelnoxPrismaClient;
  credentials: CredentialReader;
  mailer: Mailer;
  productVersion: string;
  provisioningId: string;
}): Promise<'sent' | 'skipped'> {
  const { prisma } = input;
  return withSystemScope('a notification is sent on behalf of whoever asked', async () => {
    const claimed = await prisma.provisioning.updateMany({
      where: { id: input.provisioningId, notifiedAt: null, notify: true, state: 'SUCCEEDED' },
      data: { notifiedAt: new Date() },
    });
    if (claimed.count === 0) return 'skipped';

    try {
      const row = await prisma.provisioning.findUniqueOrThrow({
        where: { id: input.provisioningId },
      });
      if (!row.requestedByEmail) return 'skipped';
      const [user, settings] = await Promise.all([
        row.requestedById
          ? prisma.user.findUnique({
              where: { id: row.requestedById },
              select: { locale: true, timezone: true },
            })
          : null,
        prisma.systemSettings.findUniqueOrThrow({
          where: { id: 1 },
          select: { baseUrl: true, defaultLocale: true, defaultTimezone: true },
        }),
      ]);
      const locale = (user?.locale ?? settings.defaultLocale) === 'nl' ? 'nl' : 'en';
      const timeZone = user?.timezone ?? settings.defaultTimezone;

      const encrypted = row.credentialDelivery === 'ENCRYPTED_PDF';
      let accounts: { name: string; password: string | null; administrator: boolean }[] | undefined;
      let password: string | undefined;
      if (encrypted) {
        if (!row.credentialsCredentialId || !row.documentPasswordCredentialId) {
          throw new Error('The encrypted record needs the VM’s credentials and its own password');
        }
        accounts = (await input.credentials.guestCredentials(row.credentialsCredentialId)).accounts;
        password = await input.credentials.documentPassword(row.documentPasswordCredentialId);
      }

      const pdf = await renderRecord({
        locale,
        timeZone,
        productVersion: input.productVersion,
        hostname: row.hostname,
        vmid: row.vmid,
        clusterName: row.clusterName,
        node: row.node,
        templateName: row.templateName,
        family: row.family,
        addresses: row.addresses,
        requestedBy: row.requestedByLabel,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        accounts,
        password,
      });

      const link = settings.baseUrl
        ? `${settings.baseUrl.replace(/\/+$/, '')}/provisioning/${row.id}`
        : null;
      await input.mailer.send({
        to: row.requestedByEmail,
        subject: SUBJECT[locale](row.hostname),
        text: BODY[locale]({
          host: row.hostname,
          vmid: row.vmid === null ? '—' : String(row.vmid),
          cluster: row.clusterName,
          node: row.node,
          addresses: row.addresses.length ? row.addresses.join(', ') : '—',
          link,
          credentials: encrypted ? 'pdf' : 'velnox',
          finished: formatWhen(row.finishedAt, locale, timeZone),
        }),
        attachments: [
          {
            filename: `${row.hostname}-${locale === 'nl' ? 'installatieverslag' : 'installation-record'}.pdf`,
            content: pdf,
            contentType: 'application/pdf',
          },
        ],
      });
      return 'sent';
    } catch (error) {
      // Not sent: release the claim so a later attempt may try.
      await prisma.provisioning
        .updateMany({ where: { id: input.provisioningId }, data: { notifiedAt: null } })
        .catch(() => undefined);
      throw error;
    }
  });
}
