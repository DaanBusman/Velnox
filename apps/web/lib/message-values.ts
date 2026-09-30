/**
 * Error params as a translated message can take them.
 *
 * The API's params are strings, numbers, booleans and nulls; next-intl takes
 * strings, numbers and dates. A null becomes an empty string and a boolean its
 * word, so a message is never handed a value it cannot print — which is what a
 * cast to make the types agree would have done instead.
 */
export function messageValues(
  params: Record<string, string | number | boolean | null> | null | undefined,
): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    values[key] = value === null ? '' : typeof value === 'boolean' ? String(value) : value;
  }
  return values;
}
