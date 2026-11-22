import { describe, expect, it } from 'vitest';
import { isJobReturnPath } from './push';

const JOB = '3f2a7c1e-9b4d-4e21-8c55-0a1b2c3d4e5f';

describe('the way back after signing in', () => {
  it.each([`/jobs/${JOB}`, `/jobs/${JOB}?decide=approve`, `/jobs/${JOB}?decide=reject`])(
    'allows %s',
    (path) => expect(isJobReturnPath(path)).toBe(true),
  );

  it.each([
    '/',
    '/clusters',
    '//evil.example/',
    'https://evil.example/',
    `/jobs/${JOB}/../../x`,
    `/jobs/${JOB}?decide=delete`,
    `/jobs/${JOB}?next=https://evil.example`,
    `/jobs/${JOB}?decide=approve#x`,
  ])('refuses %s', (path) => expect(isJobReturnPath(path)).toBe(false));
});
