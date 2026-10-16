import { getDoc } from '@/lib/docs';

/**
 * How far along this build is, read from the roadmap it ships with.
 *
 * The dashboard said "this installation is running a phase 5 build" for four
 * phases after it stopped being true, because the sentence was a string in the
 * locale files. The roadmap is what records how far along Velnox is — the
 * version follows it (scripts/version.mjs) — and its translation ships in the
 * same build as the page, so reading it here cannot fall behind.
 *
 * Its headings look like `Phase 7B — Cluster resource scheduling (…) · L · ✅
 * complete`; a built phase says "built, not yet complete" (or, in Dutch,
 * "gebouwd, nog niet afgerond"), a planned one has no status at all.
 */

export type PhaseStatus = 'complete' | 'built' | 'planned';

export interface RoadmapPhase {
  /** `7`, `7B`. */
  id: string;
  number: number;
  name: string;
  status: PhaseStatus;
  /** The heading's anchor in the roadmap, to link to. */
  anchor: string;
}

const HEADING = /^Phase (\d+)([A-Z]?) — (.+?) · (?:S|M|L|XL)(?: · (.+))?$/;

export function roadmapPhases(locale: string): RoadmapPhase[] {
  const doc = getDoc('roadmap', locale);
  if (!doc) return [];
  return doc.page.headings.flatMap((heading) => {
    const match = HEADING.exec(heading.text);
    if (!match) return [];
    const state = match[4] ?? '';
    const status: PhaseStatus = /✅/.test(state)
      ? 'complete'
      : /built|gebouwd/i.test(state)
        ? 'built'
        : 'planned';
    return [
      {
        id: `${match[1]}${match[2]}`,
        number: Number(match[1]),
        name: match[3]!,
        status,
        anchor: heading.id,
      },
    ];
  });
}

/** Whether any part of a phase number — 9, 9A or 9B — is built or complete. */
export function phaseAvailable(phases: RoadmapPhase[], number: number): boolean {
  return phases.some((phase) => phase.number === number && phase.status !== 'planned');
}
