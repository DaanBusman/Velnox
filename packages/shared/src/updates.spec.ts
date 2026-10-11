import { describe, expect, it } from 'vitest';
import { openings, parseRule, ruleProblem, windowState, zonedParts, zonedToInstant } from './rrule';
import {
  classifyPackage,
  compareVersions,
  maintenanceWindowSchema,
  newerKernelInstalled,
} from './updates';

const AMS = 'Europe/Amsterdam';
const at = (iso: string) => Date.parse(iso);

describe('parseRule', () => {
  it('reads the supported subset', () => {
    expect(parseRule('FREQ=WEEKLY;BYDAY=SU;BYHOUR=2;BYMINUTE=30')).toEqual({
      freq: 'WEEKLY',
      byDay: [{ day: 'SU', nth: null }],
      byMonthDay: [],
      byHour: [2],
      byMinute: [30],
    });
    expect(parseRule('RRULE:FREQ=MONTHLY;BYDAY=-1SA').byDay).toEqual([{ day: 'SA', nth: -1 }]);
  });

  it('refuses what it does not support, rather than guessing', () => {
    expect(ruleProblem('FREQ=WEEKLY;INTERVAL=2')).toMatch(/INTERVAL is not supported/);
    expect(ruleProblem('FREQ=YEARLY')).toMatch(/FREQ/);
    expect(ruleProblem('FREQ=WEEKLY;BYDAY=1SU')).toMatch(/MONTHLY/);
    expect(ruleProblem('FREQ=MONTHLY')).toMatch(/names its day/);
    expect(ruleProblem('FREQ=DAILY;BYHOUR=24')).toMatch(/range/);
    expect(ruleProblem('FREQ=DAILY;BYHOUR=2;BYHOUR=3')).toMatch(/twice/);
    expect(ruleProblem('FREQ=DAILY;BYHOUR=2')).toBeNull();
  });
});

describe('time zones', () => {
  it('turns a wall-clock time into the instant it happens, summer and winter', () => {
    expect(new Date(zonedToInstant(2026, 7, 5, 2, 0, AMS)).toISOString()).toBe(
      '2026-07-05T00:00:00.000Z',
    );
    expect(new Date(zonedToInstant(2026, 1, 4, 2, 0, AMS)).toISOString()).toBe(
      '2026-01-04T01:00:00.000Z',
    );
  });

  it('moves a time the clock skips to the end of the gap', () => {
    // 29 March 2026: Amsterdam jumps from 02:00 to 03:00.
    const instant = zonedToInstant(2026, 3, 29, 2, 30, AMS);
    expect(zonedParts(instant, AMS).hour).toBe(3);
  });

  it('takes the first of a time that happens twice', () => {
    // 25 October 2026: 02:30 happens at 00:30 and 01:30 UTC.
    expect(new Date(zonedToInstant(2026, 10, 25, 2, 30, AMS)).toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });
});

describe('windows', () => {
  const sunday = { rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=2', timezone: AMS, durationMinutes: 120 };

  it('opens at 02:00 local every Sunday, across the clock change', () => {
    const found = openings(sunday, at('2026-10-17T00:00:00Z'), at('2026-11-02T00:00:00Z')).map(
      (t) => new Date(t).toISOString(),
    );
    expect(found).toEqual([
      '2026-10-18T00:00:00.000Z', // summer time, UTC+2
      '2026-10-25T00:00:00.000Z', // the night the clocks go back: the first 02:00
      '2026-11-01T01:00:00.000Z', // winter time, UTC+1
    ]);
  });

  it('is open inside the window and closed outside it, and says when it next opens', () => {
    const inside = windowState(sunday, at('2026-11-01T02:30:00Z'));
    expect(inside.open).toBe(true);
    expect(new Date(inside.closesAt!).toISOString()).toBe('2026-11-01T03:00:00.000Z');
    const after = windowState(sunday, at('2026-11-01T03:00:00Z'));
    expect(after.open).toBe(false);
    expect(new Date(after.nextOpening!).toISOString()).toBe('2026-11-08T01:00:00.000Z');
  });

  it('skips blackout dates', () => {
    const state = windowState(
      { ...sunday, blackoutDates: ['2026-11-01'] },
      at('2026-11-01T01:30:00Z'),
    );
    expect(state.open).toBe(false);
  });

  it('finds the last Saturday of a month and the last day of one', () => {
    const lastSat = openings(
      { rrule: 'FREQ=MONTHLY;BYDAY=-1SA;BYHOUR=22', timezone: 'UTC', durationMinutes: 60 },
      at('2026-02-01T00:00:00Z'),
      at('2026-03-01T00:00:00Z'),
    );
    expect(lastSat.map((t) => new Date(t).toISOString())).toEqual(['2026-02-28T22:00:00.000Z']);
    const lastDay = openings(
      { rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=1', timezone: 'UTC', durationMinutes: 60 },
      at('2028-02-01T00:00:00Z'),
      at('2028-03-01T00:00:00Z'),
    );
    expect(lastDay.map((t) => new Date(t).toISOString())).toEqual(['2028-02-29T01:00:00.000Z']);
  });

  it('validates a window through its schema', () => {
    expect(
      maintenanceWindowSchema.safeParse({
        name: 'x',
        timezone: 'Mars/Base',
        rrule: 'FREQ=DAILY',
        durationMinutes: 60,
      }).success,
    ).toBe(false);
    expect(
      maintenanceWindowSchema.safeParse({
        name: 'x',
        timezone: AMS,
        rrule: 'FREQ=WEEKLY;INTERVAL=2',
        durationMinutes: 60,
      }).success,
    ).toBe(false);
    expect(
      maintenanceWindowSchema.safeParse({
        name: 'x',
        timezone: AMS,
        rrule: 'FREQ=DAILY;BYHOUR=3',
        durationMinutes: 60,
      }).success,
    ).toBe(true);
  });
});

describe('classifyPackage', () => {
  it('knows a security update by its archive, or by what the API reports', () => {
    expect(
      classifyPackage({ package: 'openssl', archive: 'Debian-Security:12/stable-security' })
        .isSecurity,
    ).toBe(true);
    expect(
      classifyPackage({
        package: 'openssl',
        origin: 'Debian',
        changelogUrl: 'https://security.debian.org/x',
      }).isSecurity,
    ).toBe(true);
    expect(classifyPackage({ package: 'vim', origin: 'Debian' }).isSecurity).toBe(false);
  });

  it('knows a kernel, and what Proxmox ships', () => {
    expect(classifyPackage({ package: 'proxmox-kernel-6.8.12-5-pve-signed' })).toMatchObject({
      isKernel: true,
      isProxmox: true,
    });
    expect(classifyPackage({ package: 'pve-manager' })).toMatchObject({
      isKernel: false,
      isProxmox: true,
    });
    expect(classifyPackage({ package: 'qemu-server' }).isProxmox).toBe(true);
    expect(classifyPackage({ package: 'libc6', origin: 'Debian' })).toMatchObject({
      isKernel: false,
      isProxmox: false,
    });
  });
});

describe('kernels', () => {
  it('says a reboot is needed when a newer kernel is installed than the one running', () => {
    expect(newerKernelInstalled('6.8.12-4-pve', ['6.8.12-4', '6.8.12-5'])).toBe('6.8.12-5');
    expect(newerKernelInstalled('6.8.12-5-pve', ['6.8.12-4', '6.8.12-5'])).toBeNull();
    expect(newerKernelInstalled('6.8.12-10-pve', ['6.8.12-9'])).toBeNull();
    expect(compareVersions('6.8.12-10', '6.8.12-9')).toBe(1);
  });
});
