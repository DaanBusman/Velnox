import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  DEFAULT_LOCALE,
  LOCALES,
  isLocale,
  parseAcceptLanguage,
  resolveLocale,
} from './index';

describe('parseAcceptLanguage', () => {
  it('orders tags by q-value', () => {
    expect(parseAcceptLanguage('en;q=0.5,nl;q=0.9,de;q=0.1')).toEqual(['nl', 'en', 'de']);
  });

  it('treats a missing q as 1', () => {
    expect(parseAcceptLanguage('nl,en;q=0.8')).toEqual(['nl', 'en']);
  });

  it('drops entries with q=0 and malformed entries', () => {
    expect(parseAcceptLanguage('de;q=0,nl,;q=0.5')).toEqual(['nl']);
  });

  it('returns nothing for absent or empty input rather than throwing', () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage('')).toEqual([]);
  });
});

describe('resolveLocale', () => {
  it('prefers an explicit user setting over everything else', () => {
    expect(
      resolveLocale({
        userPreference: 'en',
        cookie: 'nl',
        acceptLanguage: 'nl',
        installationDefault: 'nl',
      }),
    ).toBe('en');
  });

  it('falls back through cookie, then browser, then installation default', () => {
    expect(resolveLocale({ cookie: 'nl', acceptLanguage: 'en' })).toBe('nl');
    expect(resolveLocale({ acceptLanguage: 'nl-BE,en;q=0.3' })).toBe('nl');
    expect(resolveLocale({ acceptLanguage: 'de', installationDefault: 'nl' })).toBe('nl');
  });

  it('matches a regional tag to its base language', () => {
    expect(resolveLocale({ acceptLanguage: 'nl-NL' })).toBe('nl');
    expect(resolveLocale({ acceptLanguage: 'en-GB' })).toBe('en');
  });

  it('ignores unsupported values from untrusted sources', () => {
    expect(resolveLocale({ cookie: 'fr', acceptLanguage: 'fr' })).toBe(DEFAULT_LOCALE);
    expect(resolveLocale({ cookie: '../../etc/passwd' })).toBe(DEFAULT_LOCALE);
  });

  it('always returns a supported locale', () => {
    expect(isLocale(resolveLocale({}))).toBe(true);
  });
});

describe('catalogue files', () => {
  // Resolved from the package root rather than from import.meta: this package
  // compiles to CommonJS, where import.meta is not available.
  const localesDir = join(process.cwd(), 'locales');

  it('ships exactly one catalogue per supported locale', () => {
    const files = readdirSync(localesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => basename(f, '.json'))
      .sort();
    expect(files).toEqual([...LOCALES].sort());
  });

  it('declares its own locale in $meta, so a mislabelled file is caught', () => {
    for (const locale of LOCALES) {
      const data = JSON.parse(readFileSync(join(localesDir, `${locale}.json`), 'utf8'));
      expect(data.$meta.locale).toBe(locale);
    }
  });
});
