import { describe, expect, it } from 'vitest';
import { sha512Crypt } from './sha512-crypt';

/*
 * The test vectors from Drepper's specification, "Unix crypt using SHA-256 and
 * SHA-512". A crypt that disagrees with these produces hashes /etc/shadow
 * refuses, which shows up as an account nobody can log in to.
 */
describe('sha512Crypt', () => {
  it('matches the specification with the default rounds', () => {
    expect(sha512Crypt('Hello world!', { salt: 'saltstring' })).toBe(
      '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1',
    );
  });

  it('matches the specification with custom rounds and a salt cut to 16', () => {
    expect(sha512Crypt('Hello world!', { salt: 'saltstringsaltstring', rounds: 10000 })).toBe(
      '$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.',
    );
  });

  it('matches the specification for a long password', () => {
    expect(
      sha512Crypt('we have a short salt string but not a short password', {
        salt: 'short',
        rounds: 77777,
      }),
    ).toBe(
      '$6$rounds=77777$short$WuQyW2YR.hBNpjjRhpYD/ifIw05xdfeEyQoMxIXbkvr0gge1a1x3yRULJ5CCaUeOxFmtlcGZelFl5CxtgfiAc0',
    );
  });

  it('clamps rounds below the minimum up to 1000', () => {
    expect(sha512Crypt('the minimum number is still observed', { salt: 'roundstoolow', rounds: 10 })).toBe(
      '$6$rounds=1000$roundstoolow$kUMsbe306n21p9R.FRkW3IGn.S9NPN0x50YhH1xhLsPuWGsUSklZt58jaTfF4ZEQpyUNGc0dqbpBYYBaHHrsX.',
    );
  });

  it('uses a fresh 16-character salt when none is given', () => {
    const one = sha512Crypt('secret');
    const two = sha512Crypt('secret');
    expect(one).toMatch(/^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/);
    expect(one).not.toBe(two);
  });

  it('refuses a salt crypt cannot store', () => {
    expect(() => sha512Crypt('x', { salt: 'bad$salt' })).toThrow();
  });
});
