import { describe, expect, it } from 'vitest';
import { hash2B } from './pdf-r6';
import { renderRecord } from './record';

const base = {
  locale: 'en' as const,
  timeZone: 'Europe/Amsterdam',
  productVersion: '0.5.7',
  hostname: 'WS-001',
  vmid: 123,
  clusterName: 'Customer A',
  node: 'pve1',
  templateName: 'Windows 11 Pro',
  family: 'WINDOWS' as const,
  addresses: ['192.0.2.20'],
  requestedBy: 'ops@msp.example',
  startedAt: new Date(Date.UTC(2026, 8, 30, 10, 0)),
  finishedAt: new Date(Date.UTC(2026, 8, 30, 10, 23)),
};

/** The encryption dictionary's hex strings, as pdfkit writes them. */
function entry(pdf: Buffer, name: string): Buffer | null {
  const match = new RegExp(`/${name} <([0-9a-fA-F]+)>`).exec(pdf.toString('latin1'));
  return match ? Buffer.from(match[1]!, 'hex') : null;
}

describe('renderRecord', () => {
  it('writes a PDF without passwords and without encryption when none are given', async () => {
    const pdf = await renderRecord(base);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).not.toContain('/Encrypt');
  });

  it('refuses to write passwords into an unencrypted record', async () => {
    await expect(
      renderRecord({ ...base, accounts: [{ name: 'ops', password: 'x', administrator: true }] }),
    ).rejects.toThrow(/encrypted/);
  });

  it('encrypts a record with passwords as AES-256 revision 6, and the password opens it', async () => {
    const password = 'open-sesame-42';
    const pdf = await renderRecord({
      ...base,
      accounts: [{ name: 'beheer', password: 'Sample-Pass-7x', administrator: true }],
      password,
    });
    const text = pdf.toString('latin1');
    expect(text).toMatch(/\/R 6\b/);
    expect(text).toMatch(/\/V 5\b/);
    expect(text).toContain('/AESV3');
    // Nothing readable: not the account's password, not the document's.
    expect(text).not.toContain('Sample-Pass-7x');
    expect(text).not.toContain(password);

    // The user password validates against U the way a reader checks it.
    const u = entry(pdf, 'U')!;
    expect(u).toHaveLength(48);
    const validation = hash2B(Buffer.from(password), u.subarray(32, 40), Buffer.alloc(0));
    expect(validation.equals(u.subarray(0, 32))).toBe(true);
    const wrong = hash2B(Buffer.from('not-it'), u.subarray(32, 40), Buffer.alloc(0));
    expect(wrong.equals(u.subarray(0, 32))).toBe(false);
  });
});
