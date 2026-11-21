import { describe, expect, it } from 'vitest';
import { wrappedFocusIndex } from './focus-trap';

describe('wrappedFocusIndex', () => {
  it('wraps from the last element to the first', () => {
    expect(wrappedFocusIndex(4, 3, false)).toBe(0);
  });

  it('wraps from the first element to the last when going backwards', () => {
    expect(wrappedFocusIndex(4, 0, true)).toBe(3);
  });

  it('leaves movement between the ends to the browser', () => {
    expect(wrappedFocusIndex(4, 1, false)).toBeNull();
    expect(wrappedFocusIndex(4, 2, true)).toBeNull();
  });

  it('brings focus back in when it is outside the list', () => {
    expect(wrappedFocusIndex(4, -1, false)).toBe(0);
    expect(wrappedFocusIndex(4, -1, true)).toBe(3);
  });

  it('keeps a single element focused in both directions', () => {
    expect(wrappedFocusIndex(1, 0, false)).toBe(0);
    expect(wrappedFocusIndex(1, 0, true)).toBe(0);
  });

  it('has nowhere to go in an empty list', () => {
    expect(wrappedFocusIndex(0, -1, false)).toBeNull();
  });
});
