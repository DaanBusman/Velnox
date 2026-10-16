import { describe, expect, it } from 'vitest';
import { phaseAvailable, roadmapPhases } from './roadmap';

/**
 * The dashboard's "what this build can do" comes from the roadmap in the
 * documentation bundle. If the headings change shape, the notice must not go
 * quietly empty — it would say nothing, which is how the old one said "phase
 * 5" for four phases. These hold for whatever the roadmap says today.
 */
describe('the roadmap, as the dashboard reads it', () => {
  for (const locale of ['en', 'nl']) {
    it(`finds every phase from 1 to 15 in ${locale}`, () => {
      const numbers = new Set(roadmapPhases(locale).map((p) => p.number));
      for (let n = 1; n <= 15; n += 1) expect(numbers.has(n)).toBe(true);
    });
  }

  it('reads the same status for every phase in both languages', () => {
    const status = (locale: string) =>
      Object.fromEntries(roadmapPhases(locale).map((p) => [p.id, p.status]));
    expect(status('nl')).toEqual(status('en'));
  });

  it('knows a complete phase, a built one and a planned one apart', () => {
    const statuses = new Set(roadmapPhases('en').map((p) => p.status));
    expect(statuses.has('complete')).toBe(true);
    expect(statuses.has('planned')).toBe(true);
  });

  it('counts a phase available when any part of it is built', () => {
    const phases = [
      { id: '9A', number: 9, name: 'a', status: 'built' as const, anchor: '' },
      { id: '9B', number: 9, name: 'b', status: 'planned' as const, anchor: '' },
      { id: '10', number: 10, name: 'c', status: 'planned' as const, anchor: '' },
    ];
    expect(phaseAvailable(phases, 9)).toBe(true);
    expect(phaseAvailable(phases, 10)).toBe(false);
  });
});
