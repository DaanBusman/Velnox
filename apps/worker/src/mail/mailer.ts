import { createTransport } from 'nodemailer';
import { withSystemScope, type VelnoxPrismaClient } from '@velnox/db';
import type { CredentialReader } from '../inventory/credentials';

/**
 * Sending mail — the worker's job, because the worker is what may read the
 * mail server's password (ADR-009).
 *
 * Settings are read from the database at every send rather than cached, so a
 * change in Server management applies to the next mail without a restart, and
 * the password is decrypted for the one connection that needs it and dropped
 * with it.
 *
 * **Certificates are verified.** STARTTLS is required when chosen — a server
 * that does not offer it is a refusal, not a quiet fall back to plain text —
 * and TLS from the first byte is available for port 465. `NONE` exists for a
 * relay on the same host, and says what it is.
 */

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super('Outgoing mail is not set up');
    this.name = 'MailNotConfiguredError';
  }
}

const TIMEOUT_MS = 20_000;

export class Mailer {
  constructor(
    private readonly prisma: VelnoxPrismaClient,
    private readonly credentials: CredentialReader,
    private readonly productVersion: string,
  ) {}

  private settings() {
    // Awaited inside: a Prisma query is lazy, and would otherwise run after the scope ended.
    return withSystemScope(
      'outgoing mail is installation-wide',
      async () => await this.prisma.systemSettings.findUniqueOrThrow({ where: { id: 1 } }),
    );
  }

  /** Whether mail may be sent at all: set up and proven. */
  async enabled(): Promise<boolean> {
    return (await this.settings()).smtpEnabled;
  }

  /**
   * Send one mail. `test` sends with settings that are not switched on yet —
   * that is how they get proven.
   */
  async send(mail: OutgoingMail, options: { test?: boolean } = {}): Promise<void> {
    const s = await this.settings();
    if (!s.smtpHost || !s.smtpFrom || (!s.smtpEnabled && !options.test)) {
      throw new MailNotConfiguredError();
    }
    const password = s.smtpPasswordCredentialId
      ? await this.credentials.smtpPassword(s.smtpPasswordCredentialId)
      : null;

    const transport = createTransport({
      host: s.smtpHost,
      port: s.smtpPort,
      secure: s.smtpSecurity === 'TLS',
      requireTLS: s.smtpSecurity === 'STARTTLS',
      ignoreTLS: s.smtpSecurity === 'NONE',
      ...(s.smtpUsername && password ? { auth: { user: s.smtpUsername, pass: password } } : {}),
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS * 3,
      // Nothing from the conversation is logged: it carries the AUTH exchange.
      logger: false,
      debug: false,
    });
    try {
      await transport.sendMail({
        from: s.smtpFrom,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        headers: { 'X-Mailer': `Velnox ${this.productVersion}` },
        attachments: mail.attachments,
      });
    } finally {
      transport.close();
    }
  }
}
