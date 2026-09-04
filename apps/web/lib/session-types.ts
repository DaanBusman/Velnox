/**
 * Shapes shared by the server-side session reader and the client components
 * that display it.
 *
 * Separate from `session.ts` because that module is `server-only`: a Client
 * Component importing from it is a build error, and relying on `import type`
 * being erased before the bundler notices is the kind of thing that works until
 * a compiler setting changes.
 */

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  isMspRoot: boolean;
  permissions: string[];
  mfa: {
    enrolled: boolean;
    required: boolean;
    policy: 'OPTIONAL' | 'REQUIRED_FOR_PRIVILEGED' | 'REQUIRED';
  };
}

export interface Session {
  user: SessionUser;
  /** False while the user still owes a second factor. */
  mfaSatisfied: boolean;
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  status: string;
  tenantId: string;
  tenantName: string;
  mfaEnrolled: boolean;
  privileged: boolean;
  roles: string[];
  lastLoginAt: string | null;
  createdAt: string;
}
