import 'reflect-metadata';
import { existsSync, readdirSync } from 'node:fs';
import { join as joinPath, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ALLOWS_UNSATISFIED_MFA, IS_PUBLIC } from './auth.guard';
import { AuthController } from '../modules/auth/auth.controller';
import { MfaController } from '../modules/auth/mfa.controller';
import { HealthController } from '../modules/health/health.controller';
import { IdentityController } from '../modules/identity/identity.controller';
import { SetupController } from '../modules/setup/setup.controller';
import { MetricsController } from '../modules/system/metrics.controller';
import { SystemController } from '../modules/system/system.controller';
import { UsersController } from '../modules/users/users.controller';

/**
 * What a half-authenticated session can reach.
 *
 * When a policy requires a second factor and the session has not satisfied it,
 * the guard blocks every endpoint that does not carry `@AllowsUnsatisfiedMfa`.
 * The risk is not the guard — it is the decorator being added to an endpoint
 * later, by someone who needed a route to work during development and did not
 * think about what it opens.
 *
 * So this test does not check a list I wrote by hand. It discovers every
 * controller in the source tree, enumerates every route on it, and fails if the
 * set that a half-authenticated session can reach is anything other than the
 * exact set below. Adding an endpoint with the decorator breaks this test until
 * someone states, here, that reaching it before the second factor is intended.
 */

// Reachable with a session that still owes a second factor. Each is here
// because a session that could not reach it would be unable to finish
// authenticating, or unable to give up and leave.
const EXPECTED_REACHABLE = new Set([
  'GET /auth/me', //                     what the client needs to know what is owed
  'POST /auth/logout', //                the way out
  'GET /auth/mfa', //                    whether a factor exists to answer with
  'POST /auth/mfa/enrol', //             required policy, never enrolled
  'POST /auth/mfa/enrol/confirm', //     ditto
  'POST /auth/mfa/challenge', //         the challenge itself
  'POST /auth/mfa/challenge/recovery', // the challenge, without the phone
]);

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.ALL]: 'ALL',
};

interface Route {
  signature: string;
  isPublic: boolean;
  allowsUnsatisfiedMfa: boolean;
}

/*
 * Every controller in the application.
 *
 * Listed explicitly rather than globbed, because a glob is bundler magic that
 * does not survive the CommonJS typecheck. The list not falling behind the
 * source tree is itself asserted below, by counting the controller files on
 * disk — so adding a controller and forgetting this list fails loudly instead
 * of quietly shrinking what the test covers.
 */
const CONTROLLERS = [
  AuthController,
  MfaController,
  HealthController,
  SetupController,
  MetricsController,
  SystemController,
  UsersController,
  IdentityController,
];

function collectRoutes(): Route[] {
  const routes: Route[] = [];

  for (const controller of CONTROLLERS) {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, controller);
    if (controllerPath === undefined) continue; // not a @Controller

    const prototype = controller.prototype as object;
    const classPublic = Reflect.getMetadata(IS_PUBLIC, controller) === true;
    const classMfa = Reflect.getMetadata(ALLOWS_UNSATISFIED_MFA, controller) === true;

    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = Object.getOwnPropertyDescriptor(prototype, name)?.value;
      if (typeof handler !== 'function') continue;

      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      if (method === undefined) continue; // not a route handler

      const methodPath = Reflect.getMetadata(PATH_METADATA, handler) ?? '/';
      routes.push({
        signature: `${METHOD_NAMES[method] ?? String(method)} ${join(controllerPath, methodPath)}`,
        isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC, handler) === true,
        allowsUnsatisfiedMfa:
          classMfa || Reflect.getMetadata(ALLOWS_UNSATISFIED_MFA, handler) === true,
      });
    }
  }

  return routes;
}

/** Locate `src/modules` whether the runner starts in the package or the repo. */
function modulesDir(): string {
  for (const candidate of ['src/modules', 'apps/api/src/modules']) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(`Cannot find src/modules from ${process.cwd()}`);
}

function controllerFilesOnDisk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = joinPath(dir, entry.name);
    if (entry.isDirectory()) found.push(...controllerFilesOnDisk(path));
    else if (entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.spec.ts')) {
      found.push(path);
    }
  }
  return found;
}

function join(controllerPath: string, methodPath: string): string {
  const left = `/${String(controllerPath).replace(/^\/|\/$/g, '')}`;
  const right = String(methodPath).replace(/^\/|\/$/g, '');
  return right ? `${left}/${right}` : left;
}

describe('what a session owing a second factor can reach', () => {
  const routes = collectRoutes();

  it('covers every controller in the source tree', () => {
    // The guarantee this whole file rests on: the list above is the complete
    // set of controllers, not a sample of them.
    const onDisk = controllerFilesOnDisk(modulesDir());
    expect(
      CONTROLLERS.length,
      `Controllers on disk:\n${onDisk.join('\n')}\nAdd any missing one to CONTROLLERS.`,
    ).toBe(onDisk.length);

    expect(routes.length).toBeGreaterThan(8);
    expect(routes.map((r) => r.signature)).toContain('POST /auth/login');
  });

  it('opens exactly the endpoints needed to finish or abandon authentication', () => {
    const reachable = routes
      .filter((route) => route.allowsUnsatisfiedMfa && !route.isPublic)
      .map((route) => route.signature)
      .sort();

    expect(reachable).toEqual([...EXPECTED_REACHABLE].sort());
  });

  it('leaves every other authenticated endpoint closed', () => {
    const closed = routes.filter((route) => !route.isPublic && !route.allowsUnsatisfiedMfa);

    // Not merely "none of the expected set" — there must be real endpoints on
    // the other side of the gate, or the gate is protecting nothing.
    expect(closed.length).toBeGreaterThan(0);
    for (const route of closed) {
      expect(EXPECTED_REACHABLE.has(route.signature)).toBe(false);
    }
  });

  it('does not let a public endpoint also claim the MFA exemption', () => {
    // Both decorators on one handler is always a mistake: @Public() already
    // skips the guard entirely, so the exemption is dead metadata that misleads
    // the next reader about what the endpoint requires.
    for (const route of routes) {
      expect(route.isPublic && route.allowsUnsatisfiedMfa, route.signature).toBe(false);
    }
  });

  it('keeps the endpoints that weaken a factor behind a satisfied session', () => {
    // Regenerating recovery codes or removing the factor from a session that
    // has not proven the factor would defeat the point of requiring it.
    const mustBeClosed = ['POST /auth/mfa/recovery-codes', 'POST /auth/mfa/disable'];
    for (const signature of mustBeClosed) {
      const route = routes.find((r) => r.signature === signature);
      expect(route, `${signature} should exist`).toBeDefined();
      expect(route!.allowsUnsatisfiedMfa, signature).toBe(false);
      expect(route!.isPublic, signature).toBe(false);
    }
  });
});
