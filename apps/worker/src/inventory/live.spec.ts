import { describe, expect, it } from 'vitest';
import { watchedIntervals } from './live';

const A = '7aca66b8-fce5-46e1-be80-46e89221de55';
const B = '3d8c7c82-fd61-4549-bc5f-a413f1b8da2b';

describe('watchedIntervals', () => {
  it('takes the most eager viewer of each cluster', () => {
    const wanted = watchedIntervals([`${A}:30`, `${A}:2`, `${B}:10`]);
    expect(wanted.get(A)).toBe(2);
    expect(wanted.get(B)).toBe(10);
  });

  it('ignores what it does not recognise, and anything faster than two seconds', () => {
    const wanted = watchedIntervals(['nonsense', `${A}:0`, `${A}:1`, `not-a-uuid:5`]);
    expect(wanted.size).toBe(0);
  });
});
