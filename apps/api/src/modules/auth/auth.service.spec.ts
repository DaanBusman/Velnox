import { describe, expect, it } from 'vitest';
import { resolveMfaObligation, strictestPolicy } from './auth.service';

/**
 * Who has to present a second factor.
 *
 * The whole matrix is enumerated rather than sampled, because every cell here
 * is a way in, and the two mistakes this guards against both look correct when
 * you only check the cells you were thinking about.
 */

describe('resolveMfaObligation', () => {
  const cases: {
    policy: 'OPTIONAL' | 'REQUIRED_FOR_PRIVILEGED' | 'REQUIRED';
    privileged: boolean;
    enrolled: boolean;
    required: boolean;
    owed: boolean;
    why: string;
  }[] = [
    {
      policy: 'OPTIONAL',
      privileged: false,
      enrolled: false,
      required: false,
      owed: false,
      why: 'nothing configured and nothing enrolled: password only',
    },
    {
      policy: 'OPTIONAL',
      privileged: true,
      enrolled: false,
      required: false,
      owed: false,
      why: 'a privileged account is still not compelled under an optional policy',
    },
    {
      policy: 'OPTIONAL',
      privileged: false,
      enrolled: true,
      required: false,
      owed: true,
      why: 'enrolled voluntarily — asking is the entire point of having enrolled',
    },
    {
      policy: 'REQUIRED_FOR_PRIVILEGED',
      privileged: false,
      enrolled: false,
      required: false,
      owed: false,
      why: 'the policy does not reach an unprivileged account',
    },
    {
      policy: 'REQUIRED_FOR_PRIVILEGED',
      privileged: true,
      enrolled: false,
      required: true,
      owed: true,
      why: 'compelled, and with nothing to answer with: must enrol before anything opens',
    },
    {
      policy: 'REQUIRED_FOR_PRIVILEGED',
      privileged: true,
      enrolled: true,
      required: true,
      owed: true,
      why: 'compelled and able to answer',
    },
    {
      policy: 'REQUIRED',
      privileged: false,
      enrolled: false,
      required: true,
      owed: true,
      why: 'required of everyone, enrolled or not',
    },
    {
      policy: 'REQUIRED',
      privileged: false,
      enrolled: true,
      required: true,
      owed: true,
      why: 'required of everyone',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.policy}, privileged=${testCase.privileged}, enrolled=${testCase.enrolled}: ${testCase.why}`, () => {
      expect(
        resolveMfaObligation({
          policy: testCase.policy,
          holdsPrivilegedPermission: testCase.privileged,
          enrolled: testCase.enrolled,
        }),
      ).toEqual({ required: testCase.required, owed: testCase.owed });
    });
  }

  it('never lets a required policy be escaped by not enrolling', () => {
    // The failure mode: `required && enrolled` would return owed=false here,
    // and the accounts that ignored the requirement would be the ones it no
    // longer applied to.
    for (const policy of ['REQUIRED', 'REQUIRED_FOR_PRIVILEGED'] as const) {
      const result = resolveMfaObligation({
        policy,
        holdsPrivilegedPermission: true,
        enrolled: false,
      });
      expect(result).toEqual({ required: true, owed: true });
    }
  });

  it('always challenges an enrolled user, whatever the policy says', () => {
    // The mirror failure: deciding from the policy alone means a voluntarily
    // enrolled factor is never asked for.
    for (const policy of ['OPTIONAL', 'REQUIRED_FOR_PRIVILEGED', 'REQUIRED'] as const) {
      expect(
        resolveMfaObligation({ policy, holdsPrivilegedPermission: false, enrolled: true }).owed,
      ).toBe(true);
    }
  });
});

describe('strictestPolicy', () => {
  it('takes the stricter of installation and tenant, in either order', () => {
    expect(strictestPolicy('OPTIONAL', 'REQUIRED')).toBe('REQUIRED');
    expect(strictestPolicy('REQUIRED', 'OPTIONAL')).toBe('REQUIRED');
    expect(strictestPolicy('REQUIRED_FOR_PRIVILEGED', 'REQUIRED')).toBe('REQUIRED');
    expect(strictestPolicy('OPTIONAL', 'REQUIRED_FOR_PRIVILEGED')).toBe('REQUIRED_FOR_PRIVILEGED');
  });

  it('never resolves to something looser than either input', () => {
    // A tenant must not be able to weaken what the installation requires.
    const rank = { OPTIONAL: 0, REQUIRED_FOR_PRIVILEGED: 1, REQUIRED: 2 } as const;
    const policies = ['OPTIONAL', 'REQUIRED_FOR_PRIVILEGED', 'REQUIRED'] as const;

    for (const a of policies) {
      for (const b of policies) {
        expect(rank[strictestPolicy(a, b)]).toBe(Math.max(rank[a], rank[b]));
      }
    }
  });
});
