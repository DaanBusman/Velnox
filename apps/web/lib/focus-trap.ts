/**
 * Where Tab has to send focus to stay inside a modal, or `null` when the browser
 * can be left to move it.
 *
 * An active index of -1 means focus is outside the list altogether, which
 * happens when the element holding it disappeared: Tab then re-enters at the
 * near end rather than continuing through the page behind.
 */
export function wrappedFocusIndex(
  count: number,
  activeIndex: number,
  backwards: boolean,
): number | null {
  if (count === 0) return null;
  if (activeIndex < 0) return backwards ? count - 1 : 0;
  if (backwards && activeIndex === 0) return count - 1;
  if (!backwards && activeIndex === count - 1) return 0;
  return null;
}
