import { describe, expect, it } from 'vitest';
import {
  ARGON2_OPTIONS,
  PASSWORD_MIN_LENGTH,
  checkPasswordStrength,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password';

describe('hashing', () => {
  it('produces an Argon2id PHC string with the configured parameters', async () => {
    const hash = await hashPassword('a-perfectly-fine-passphrase');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(ARGON2_OPTIONS.memoryCost).toBe(65_536);
  });

  it('never stores the password itself', async () => {
    const password = 'needle-in-the-haystack-42';
    expect(await hashPassword(password)).not.toContain('needle');
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same-password-twice');
    const b = await hashPassword('same-password-twice');
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same-password-twice')).toBe(true);
    expect(await verifyPassword(b, 'same-password-twice')).toBe(true);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword(hash, 'correct-horse-battery')).toBe(true);
    expect(await verifyPassword(hash, 'correct-horse-batterX')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('fails the login rather than the request when a stored hash is corrupt', async () => {
    for (const bad of ['', 'not-a-hash', '$argon2id$garbage', '$2b$10$bcryptstylehash']) {
      expect(await verifyPassword(bad, 'anything'), bad).toBe(false);
    }
  });

  it('handles unicode and very long passphrases', async () => {
    const passphrase = 'ün🔐-wachtwoord-met-emoji-en-accenten';
    expect(await verifyPassword(await hashPassword(passphrase), passphrase)).toBe(true);

    const long = 'x'.repeat(200);
    expect(await verifyPassword(await hashPassword(long), long)).toBe(true);
  });
});

describe('needsRehash', () => {
  it('accepts a hash made with the current parameters', async () => {
    expect(needsRehash(await hashPassword('current-parameters-please'))).toBe(false);
  });

  it('flags weaker parameters for transparent upgrade on next login', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=4$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=65536,t=1,p=4$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('flags anything it cannot parse, including a different algorithm', () => {
    expect(needsRehash('$2b$10$bcrypt')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});

describe('checkPasswordStrength', () => {
  it('accepts a reasonable passphrase', () => {
    for (const good of [
      'correct-horse-battery-staple',
      'Zeewaardig-Anker-2026',
      'a-long-enough-one-9',
    ]) {
      expect(checkPasswordStrength(good), good).toEqual({ ok: true, problems: [] });
    }
  });

  it('rejects anything below the minimum length', () => {
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(12);
    expect(checkPasswordStrength('Short1!').problems).toContain('too_short');
    expect(checkPasswordStrength('').problems).toContain('too_short');
  });

  it('sees through the decoration people add when told a password is weak', () => {
    /*
     * The regression this exists for. The blocklist matched whole passwords, so
     * appending a digit walked straight past it — and a running installation
     * accepted `password1234` for its first administrator account, which is how
     * it was found.
     *
     * Every one of these is the same word to an attacker's list.
     */
    for (const decorated of [
      'password1234',
      'Password2026',
      'P@ssw0rd!23',
      'passw0rd',
      'velnox2026!',
      'Velnox123456',
      'proxmox2024',
      'letmein!!!!!!',
      'ChangeMe-2026',
    ]) {
      expect(checkPasswordStrength(decorated).problems, decorated).toContain('too_common');
    }
  });

  it('rejects a password that is only digits, however long', () => {
    // Length is meant to buy entropy; a twelve-digit number does not.
    expect(checkPasswordStrength('839201847362').problems).toContain('too_simple');
  });

  it('does not reject a passphrase that merely contains a common word', () => {
    // The stem check must not become a substring check: a long passphrase is
    // exactly what this is trying to encourage, and rejecting it would push
    // people back towards short passwords with a symbol in them.
    for (const good of [
      'correct horse battery staple',
      'my password is a whole sentence',
      'velnox runs the whole fleet quietly',
    ]) {
      expect(checkPasswordStrength(good).problems, good).not.toContain('too_common');
    }
  });

  it('rejects obvious passwords that are long enough to pass a length check', () => {
    for (const bad of ['password123', 'administrator', 'Velnox123', 'proxmox123']) {
      expect(checkPasswordStrength(bad).problems, bad).toContain('too_common');
    }
  });

  it('rejects repetition and straight keyboard runs', () => {
    expect(checkPasswordStrength('aaaaaaaaaaaaaaaa').problems).toContain('too_repetitive');
    expect(checkPasswordStrength('abababababababab').problems).toContain('too_repetitive');
    expect(checkPasswordStrength('qwertyuiopasdfgh').problems).toContain('too_predictable');
  });

  it('rejects a password containing the account name', () => {
    const result = checkPasswordStrength('daan-is-de-beheerder', { email: 'daan@example.com' });
    expect(result.problems).toContain('contains_email');
  });

  it('does not demand a character-class recipe of a long passphrase', () => {
    // Twenty-plus lowercase letters is stronger than "P@ssw0rd!" and must pass.
    expect(checkPasswordStrength('kater bureau lamp wolk regen').ok).toBe(true);
  });

  it('does require some variety of a shorter one', () => {
    expect(checkPasswordStrength('katerbureaulamp').problems).toContain('too_simple');
  });

  it('reports codes rather than sentences, so the frontend can translate them', () => {
    for (const problem of checkPasswordStrength('short').problems) {
      expect(problem).toMatch(/^[a-z_]+$/);
    }
  });

  it('reports every problem at once instead of one per attempt', () => {
    const result = checkPasswordStrength('aaa', { email: 'aaa@example.com' });
    expect(result.problems.length).toBeGreaterThan(1);
  });
});
