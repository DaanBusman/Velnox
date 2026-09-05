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
  roles: { assignmentId: string; roleId: string; name: string; scopeType: string }[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface IdentityProviderView {
  configured: boolean;
  enabled: boolean;
  name: string;
  discoveryUrl: string | null;
  issuer: string | null;
  clientId: string | null;
  /** Whether a secret is stored. Never the secret itself. */
  clientSecretSet: boolean;
  allowedEmailDomains: string[];
  autoProvision: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  /** Whether signing in through this provider works in this build. */
  signInAvailable: boolean;
  /** What to register as the redirect URI in the directory. Derived server-side. */
  redirectUri: string;
  /** A name for the app registration that identifies this installation. */
  suggestedAppName: string;
}

export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  mspOnly: boolean;
  permissions: string[];
  /** Stored against the role but not recognised by this build. */
  unknownPermissions: string[];
  assignmentCount: number;
}

export interface AuditEventView {
  id: string;
  at: string;
  action: string;
  result: 'SUCCESS' | 'FAILURE' | 'DENIED';
  actorType: string;
  actorLabel: string | null;
  resourceType: string | null;
  resourceLabel: string | null;
  ip: string | null;
  requestId: string | null;
  metadata: unknown;
}
