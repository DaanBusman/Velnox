/**
 * Finding a time zone by typing a place (0.7.17).
 *
 * The browser knows every IANA zone (`Intl.supportedValuesOf('timeZone')`), and
 * most are named after a city, so typing "Amsterdam" finds Europe/Amsterdam on
 * the name alone. Two kinds of place do not: a capital whose zone is named after
 * another city (Den Haag, Bern, Washington), and a city typed in Dutch
 * (Parijs, Brussel, Londen). Those are listed here, pointing at the zone they
 * keep time by. A zone the browser does not know is never offered.
 */
export const PLACE_ZONES: Readonly<Record<string, string>> = Object.freeze({
  // Capitals that are not the city their zone is named after.
  'Den Haag': 'Europe/Amsterdam',
  'The Hague': 'Europe/Amsterdam',
  Bern: 'Europe/Zurich',
  Valletta: 'Europe/Malta',
  Washington: 'America/New_York',
  Ottawa: 'America/Toronto',
  Canberra: 'Australia/Sydney',
  Wellington: 'Pacific/Auckland',
  Brasília: 'America/Sao_Paulo',
  Pretoria: 'Africa/Johannesburg',
  Abuja: 'Africa/Lagos',
  Ankara: 'Europe/Istanbul',
  Beijing: 'Asia/Shanghai',
  'New Delhi': 'Asia/Kolkata',
  Delhi: 'Asia/Kolkata',
  Hanoi: 'Asia/Bangkok',
  Islamabad: 'Asia/Karachi',
  // Dutch names of cities that do have a zone.
  Parijs: 'Europe/Paris',
  Brussel: 'Europe/Brussels',
  Londen: 'Europe/London',
  Berlijn: 'Europe/Berlin',
  Kopenhagen: 'Europe/Copenhagen',
  Lissabon: 'Europe/Lisbon',
  Praag: 'Europe/Prague',
  Wenen: 'Europe/Vienna',
  Boedapest: 'Europe/Budapest',
  Warschau: 'Europe/Warsaw',
  Athene: 'Europe/Athens',
  Boekarest: 'Europe/Bucharest',
  Moskou: 'Europe/Moscow',
  Luxemburg: 'Europe/Luxembourg',
  Kiev: 'Europe/Kyiv',
  Kyiv: 'Europe/Kyiv',
  Tokio: 'Asia/Tokyo',
  Peking: 'Asia/Shanghai',
  Kaapstad: 'Africa/Johannesburg',
  'Mexico-Stad': 'America/Mexico_City',
});

export interface ZoneMatch {
  zone: string;
  /** The place typed for it, when that is not in the zone's own name. */
  place: string | null;
}

/** Lower case, no accents, underscores and slashes as spaces. */
export function normalise(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[_/]/g, ' ').toLowerCase().trim();
}

/** A zone as people read it: "Europe/Amsterdam", "America/New York". */
export const zoneLabel = (zone: string): string => zone.replace(/_/g, ' ');

/**
 * The zones that match what was typed, best first.
 *
 * The city part of a zone's name starting with the text comes first, then a
 * place from PLACE_ZONES starting with it, then the text anywhere in the
 * zone's name or a place's. `Kyiv` and `Kiev` are both tried, so a browser
 * with either spelling still finds Ukraine.
 */
export function searchTimeZones(query: string, zones: readonly string[], limit = 12): ZoneMatch[] {
  const q = normalise(query);
  if (!q) return [];
  const known = new Set(zones);
  const resolve = (zone: string): string | null => {
    if (known.has(zone)) return zone;
    if (zone === 'Europe/Kyiv' && known.has('Europe/Kiev')) return 'Europe/Kiev';
    return null;
  };

  const ranked: { match: ZoneMatch; rank: number; key: string }[] = [];
  const seen = new Set<string>();
  const add = (match: ZoneMatch, rank: number) => {
    if (seen.has(match.zone)) return;
    seen.add(match.zone);
    ranked.push({ match, rank, key: normalise(match.place ?? match.zone) });
  };

  for (const zone of zones) {
    const city = normalise(zone.slice(zone.lastIndexOf('/') + 1));
    if (city.startsWith(q)) add({ zone, place: null }, 0);
  }
  for (const [place, target] of Object.entries(PLACE_ZONES)) {
    const zone = resolve(target);
    if (zone && normalise(place).startsWith(q)) add({ zone, place }, 1);
  }
  for (const zone of zones) {
    if (normalise(zone).includes(q)) add({ zone, place: null }, 2);
  }
  for (const [place, target] of Object.entries(PLACE_ZONES)) {
    const zone = resolve(target);
    if (zone && normalise(place).includes(q)) add({ zone, place }, 3);
  }

  return ranked
    .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((entry) => entry.match);
}

/** The time it is now in a zone, as hours and minutes: "19:50". */
export function timeIn(zone: string, locale: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now);
  } catch {
    return '';
  }
}
