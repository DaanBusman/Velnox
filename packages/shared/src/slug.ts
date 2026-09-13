/**
 * URL-safe identifiers derived from a name.
 *
 * A tenant and a site both carry one. It is what appears in a URL and in a
 * report filename, so it has to survive an operator typing "Müller & Zoon B.V."
 * into a name field without producing something that breaks a path.
 *
 * Derived rather than typed by hand: asking an operator for a slug is asking
 * them to invent a second name for the same thing, and they will eventually
 * disagree with each other.
 */

/** The longest a slug may be. Long enough to stay recognisable, short enough for a path. */
export const SLUG_MAX_LENGTH = 48;

export function slugify(value: string, fallback = 'item'): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    // Strip the combining marks that NFKD just separated out, so "ü" becomes "u"
    // rather than disappearing entirely.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    // The slice can leave a trailing hyphen behind.
    .replace(/-+$/g, '');

  return slug || fallback;
}

/**
 * A slug that is not already taken, by appending `-2`, `-3` and so on.
 *
 * Two customers called "Amsterdam Datacenter" is not a mistake to refuse — it is
 * a Tuesday. The number is appended inside the length limit rather than past it,
 * so the result is still a valid slug.
 */
export function uniqueSlug(base: string, taken: ReadonlySet<string>, fallback = 'item'): string {
  const root = slugify(base, fallback);
  if (!taken.has(root)) return root;

  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${root.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }

  // A thousand collisions on one name is not a naming problem any more.
  throw new Error(`Could not derive a free slug from "${base}"`);
}
