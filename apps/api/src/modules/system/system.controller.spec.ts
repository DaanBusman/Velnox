import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { IS_PUBLIC, REQUIRED_PERMISSION } from '../../common/auth.guard';
import { SystemController } from './system.controller';

/**
 * Which system endpoints are anonymous, pinned.
 *
 * The guard resolves `@Public()` with `getAllAndOverride([handler, class])`, so
 * a class-level `@Public()` is inherited by every method on it — including one
 * that also carries `@RequirePermission`, because the guard returns early on
 * public and never reads the requirement. This controller was annotated that
 * way, and adding the certificate endpoint under it published the
 * installation's TLS configuration, the ACME account address and its proxy
 * reachability to anonymous callers.
 *
 * Two things are anonymous on purpose: `info`, which the frontend reads before
 * anyone has signed in, and `source`, which the AGPL requires be offered to
 * anyone interacting with the software. Everything else is not, and the whole
 * set is asserted rather than the new route alone — otherwise the next endpoint
 * added here inherits the mistake instead of failing this test.
 */

const publicOf = (name: keyof SystemController) =>
  Reflect.getMetadata(IS_PUBLIC, SystemController.prototype[name] as object) === true ||
  Reflect.getMetadata(IS_PUBLIC, SystemController) === true;

const permissionOf = (name: keyof SystemController) =>
  Reflect.getMetadata(REQUIRED_PERMISSION, SystemController.prototype[name] as object) as
    | { permission: string }
    | undefined;

describe('SystemController', () => {
  it('is not public as a whole', () => {
    // The class-level annotation is what made a guarded method reachable
    // anonymously. Nothing may put it back.
    expect(Reflect.getMetadata(IS_PUBLIC, SystemController)).toBeUndefined();
  });

  it.each(['info', 'source'] as const)('%s is anonymous, deliberately', (name) => {
    expect(publicOf(name)).toBe(true);
  });

  it('tls is not anonymous and requires system.manage', () => {
    expect(publicOf('tlsStatus')).toBe(false);
    expect(permissionOf('tlsStatus')?.permission).toBe('system.manage');
  });
});
