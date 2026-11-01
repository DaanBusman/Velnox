import { describe, expect, it } from 'vitest';
import { PLACE_ZONES, normalise, searchTimeZones, timeIn, zoneLabel } from './time-zones';

const ZONES = [
  'Africa/Johannesburg',
  'America/New_York',
  'America/Sao_Paulo',
  'Asia/Shanghai',
  'Europe/Amsterdam',
  'Europe/Brussels',
  'Europe/Kiev',
  'Europe/Paris',
  'Europe/Zurich',
];

describe('finding a time zone by place', () => {
  it('finds a zone by its own city, first', () => {
    expect(searchTimeZones('Amsterdam', ZONES)).toEqual([
      { zone: 'Europe/Amsterdam', place: null },
    ]);
    expect(searchTimeZones('amst', ZONES)[0]).toEqual({ zone: 'Europe/Amsterdam', place: null });
  });

  it('finds a capital that keeps another city’s time', () => {
    expect(searchTimeZones('Den Haag', ZONES)).toEqual([
      { zone: 'Europe/Amsterdam', place: 'Den Haag' },
    ]);
    expect(searchTimeZones('bern', ZONES)).toEqual([{ zone: 'Europe/Zurich', place: 'Bern' }]);
    expect(searchTimeZones('Washington', ZONES)).toEqual([
      { zone: 'America/New_York', place: 'Washington' },
    ]);
  });

  it('finds a city typed in Dutch', () => {
    expect(searchTimeZones('Parijs', ZONES)).toEqual([{ zone: 'Europe/Paris', place: 'Parijs' }]);
    // "Brussel" is the start of "Brussels" too, so the zone's own name wins.
    expect(searchTimeZones('Brussel', ZONES)).toEqual([{ zone: 'Europe/Brussels', place: null }]);
  });

  it('ignores case, accents and underscores', () => {
    expect(searchTimeZones('sao paulo', ZONES)[0]?.zone).toBe('America/Sao_Paulo');
    expect(searchTimeZones('BRASILIA', ZONES)[0]).toEqual({
      zone: 'America/Sao_Paulo',
      place: 'Brasília',
    });
    expect(normalise('Europe/New_York')).toBe('europe new york');
  });

  it('finds Kyiv under the old spelling a browser may still use', () => {
    expect(searchTimeZones('Kyiv', ZONES)).toEqual([{ zone: 'Europe/Kiev', place: 'Kyiv' }]);
  });

  it('matches anywhere, after what starts with the text', () => {
    expect(searchTimeZones('europe', ZONES).map((m) => m.zone)).toEqual([
      'Europe/Amsterdam',
      'Europe/Brussels',
      'Europe/Kiev',
      'Europe/Paris',
      'Europe/Zurich',
    ]);
  });

  it('offers nothing for an empty query, and never a zone the browser does not know', () => {
    expect(searchTimeZones('  ', ZONES)).toEqual([]);
    expect(searchTimeZones('Tokio', ZONES)).toEqual([]);
  });

  it('points every place at a real IANA zone', () => {
    for (const zone of Object.values(PLACE_ZONES)) {
      expect(() => new Intl.DateTimeFormat('en', { timeZone: zone })).not.toThrow();
    }
  });
});

describe('the time in a zone', () => {
  it('is hours and minutes on a 24-hour clock', () => {
    const at = new Date('2026-11-01T18:50:00Z');
    expect(timeIn('Europe/Amsterdam', 'nl', at)).toBe('19:50');
    expect(timeIn('America/New_York', 'en', at)).toBe('13:50');
  });

  it('is empty for a zone that does not exist', () => {
    expect(timeIn('Mars/Olympus_Mons', 'en')).toBe('');
  });

  it('reads with spaces for underscores', () => {
    expect(zoneLabel('America/New_York')).toBe('America/New York');
  });
});
