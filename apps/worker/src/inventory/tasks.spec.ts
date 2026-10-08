import { describe, expect, it } from 'vitest';
import { taskOrigin } from './tasks';

describe('taskOrigin', () => {
  it('is Velnox when the task ran with Velnox’s own credential', () => {
    expect(taskOrigin('velnox@pve!velnox', 'velnox@pve!velnox')).toBe('VELNOX');
    expect(taskOrigin('Velnox@PVE!velnox', 'velnox@pve!velnox')).toBe('VELNOX');
  });

  it('is outside Velnox for anyone else, including the same user without the token', () => {
    expect(taskOrigin('root@pam', 'velnox@pve!velnox')).toBe('OUTSIDE_VELNOX');
    expect(taskOrigin('velnox@pve', 'velnox@pve!velnox')).toBe('OUTSIDE_VELNOX');
    expect(taskOrigin('root@pam', null)).toBe('OUTSIDE_VELNOX');
  });
});
