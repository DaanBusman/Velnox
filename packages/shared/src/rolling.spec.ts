import { describe, expect, it } from 'vitest';
import { PlanRefused, planRollingGroups } from './rolling';
import { maxUnavailableNodes } from './updates';

const names = (n: number) => Array.from({ length: n }, (_, i) => `pve${i + 1}`);

describe('planRollingGroups', () => {
  it('updates one node at a time by default', () => {
    expect(
      planRollingGroups({ nodes: names(3), votingNodes: 3, concurrency: 1, alreadyDown: 0 }),
    ).toEqual([['pve1'], ['pve2'], ['pve3']]);
  });

  it('caps a group at what quorum allows, whatever was asked', () => {
    // Five voters keep quorum with two down.
    expect(
      planRollingGroups({ nodes: names(5), votingNodes: 5, concurrency: 4, alreadyDown: 0 }).map(
        (g) => g.length,
      ),
    ).toEqual([2, 2, 1]);
  });

  it('counts the nodes already down', () => {
    expect(() =>
      planRollingGroups({ nodes: names(3), votingNodes: 3, concurrency: 1, alreadyDown: 1 }),
    ).toThrow(PlanRefused);
  });

  it('refuses a two-node cluster, which loses quorum with either node down', () => {
    expect(() =>
      planRollingGroups({ nodes: names(2), votingNodes: 2, concurrency: 1, alreadyDown: 0 }),
    ).toThrow(/two-node cluster/);
  });

  it('lets a standalone node update', () => {
    expect(
      planRollingGroups({ nodes: ['pve1'], votingNodes: 1, concurrency: 3, alreadyDown: 0 }),
    ).toEqual([['pve1']]);
  });

  /*
   * The property the roadmap names: for every cluster size from 1 to 15, every
   * concurrency asked for and every number of nodes already down, a plan
   * either is refused or never has more voters down at once than quorum
   * allows — and updates every node exactly once.
   */
  it('keeps the quorum invariant for every cluster of 1 to 15 nodes', () => {
    let plans = 0;
    for (let n = 1; n <= 15; n += 1) {
      for (let k = 1; k <= 15; k += 1) {
        for (let down = 0; down < n; down += 1) {
          for (const subset of [
            names(n - down),
            names(n - down).slice(0, Math.max(1, Math.floor((n - down) / 2))),
          ]) {
            let groups: string[][];
            try {
              groups = planRollingGroups({
                nodes: subset,
                votingNodes: n,
                concurrency: k,
                alreadyDown: down,
              });
            } catch (error) {
              expect(error).toBeInstanceOf(PlanRefused);
              // Refused only when there truly was no room.
              expect(n > 1 && maxUnavailableNodes(n) - down < 1).toBe(true);
              continue;
            }
            plans += 1;
            const allowed = n <= 1 ? 1 : maxUnavailableNodes(n);
            for (const group of groups) {
              expect(group.length).toBeGreaterThan(0);
              expect(group.length).toBeLessThanOrEqual(k);
              expect(down + group.length).toBeLessThanOrEqual(allowed);
            }
            expect(groups.flat().sort()).toEqual([...subset].sort());
          }
        }
      }
    }
    expect(plans).toBeGreaterThan(500);
  });
});
