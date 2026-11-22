import { describe, expect, it } from 'vitest';
import { grantsOf, mayDecide } from './push-sender';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const GATE = { tenantId: CHILD, requiredPermission: 'upgrades.execute' };
const none = new Map<string, string[]>();
const children = new Map([[TENANT, [CHILD]]]);

const at = (scopeType: string, scopeId: string | null, ...permissions: string[]) => ({
  scopeType,
  scopeId,
  permissions,
});

describe('who is told about an approval', () => {
  it('needs both jobs.approve and what the gate asks for, at the job', () => {
    expect(mayDecide(grantsOf([at('TENANT', CHILD, 'jobs.approve', 'upgrades.execute')], none), GATE)).toBe(true);
    expect(mayDecide(grantsOf([at('TENANT', CHILD, 'jobs.approve')], none), GATE)).toBe(false);
    expect(mayDecide(grantsOf([at('TENANT', CHILD, 'upgrades.execute')], none), GATE)).toBe(false);
  });

  it('counts a global role, and a role in the main customer for its sub-customers', () => {
    expect(mayDecide(grantsOf([at('GLOBAL', null, 'jobs.approve', 'upgrades.execute')], none), GATE)).toBe(true);
    expect(mayDecide(grantsOf([at('TENANT', TENANT, 'jobs.approve', 'upgrades.execute')], children), GATE)).toBe(true);
  });

  it('does not tell another customer', () => {
    expect(mayDecide(grantsOf([at('TENANT', OTHER, 'jobs.approve', 'upgrades.execute')], children), GATE)).toBe(false);
    expect(mayDecide(grantsOf([at('TENANT', CHILD, 'jobs.approve', 'upgrades.execute')], none), { ...GATE, tenantId: TENANT })).toBe(false);
  });

  it('does not take a permission it has never heard of as met', () => {
    const everything = grantsOf([at('GLOBAL', null, 'jobs.approve', 'made.up')], none);
    expect(mayDecide(everything, { tenantId: CHILD, requiredPermission: 'made.up' })).toBe(false);
  });
});
