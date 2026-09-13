import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';

/**
 * Mandatory query scoping — layer 2 of the authorization model.
 *
 * Layer 1 is the `@RequirePermission` guard: it decides whether this principal
 * may perform this action. It is written by hand on every endpoint, which means
 * it can be forgotten, and the failure mode of a forgotten guard is an endpoint
 * that returns another customer's data.
 *
 * This layer exists so that forgetting layer 1 leaks nothing. Every query
 * against a tenant-scoped model has a tenant filter injected here, and a query
 * that runs with no scope resolved at all **throws** rather than returning
 * everything. The dangerous default is therefore "refuse", not "all rows"
 * (docs/architecture.md section 4).
 *
 * There is exactly one way past it: {@link withSystemScope}, which takes a
 * written reason and is deliberately easy to grep for. Every caller of it is a
 * place where crossing tenants is the point — authentication, the setup wizard,
 * scheduled work that belongs to no request.
 *
 * ## Why an AsyncLocalStorage rather than a parameter
 *
 * A scope passed as an argument is a scope that can be omitted, and the omission
 * compiles. Holding it in the async context means the *absence* of a scope is
 * detectable at the moment a query runs, wherever in the call graph that is, and
 * the check cannot be skipped by a service that forgot to thread a parameter
 * through.
 */

/** What the current caller may see. `'*'` is every tenant; MSP root resolves to it. */
export type TenantScope = { kind: 'all' } | { kind: 'tenants'; tenantIds: string[] };

export type TenancyState =
  /** Authenticated and resolved. Queries are filtered to these tenants. */
  | { mode: 'scoped'; scope: TenantScope }
  /** Deliberately unfiltered, with a reason. See {@link withSystemScope}. */
  | { mode: 'system'; reason: string }
  /** A request is in flight but nothing has resolved a scope yet. Queries throw. */
  | { mode: 'unresolved' };

/**
 * A mutable holder rather than the state itself.
 *
 * The request context is established by middleware, before authentication has
 * happened, so the scope is not known yet. The alternative — opening a second
 * `AsyncLocalStorage.run()` from inside the auth guard — would end the moment
 * the guard returned, which is before any controller runs. So the middleware
 * installs the holder and the guard fills it in.
 */
export interface TenancyHolder {
  state: TenancyState;
}

const storage = new AsyncLocalStorage<TenancyHolder>();

export const newTenancyHolder = (): TenancyHolder => ({ state: { mode: 'unresolved' } });

/** Run `fn` with this holder installed. Called once per request, by middleware. */
export const runWithTenancy = <T>(holder: TenancyHolder, fn: () => T): T => storage.run(holder, fn);

/** Fill in the scope for the request already in flight. Called by the auth guard. */
export function setTenantScope(scope: TenantScope): void {
  const holder = storage.getStore();
  if (holder) holder.state = { mode: 'scoped', scope };
}

export const currentTenancy = (): TenancyState | undefined => storage.getStore()?.state;

/**
 * Run something unfiltered.
 *
 * The reason is required and is not decoration: it is what a reviewer reads when
 * this shows up in a diff, and what someone auditing the codebase greps for. The
 * legitimate uses are narrow:
 *
 * - **Authentication.** Finding a user by email happens before anyone knows
 *   which tenant the request belongs to. It cannot be scoped, by definition.
 * - **The setup wizard.** It creates the first tenant; there is nothing to scope
 *   to yet.
 * - **Scheduled work.** A discovery run belongs to no request and no session.
 * - **The audit trail.** Events are written for anonymous and cross-tenant
 *   actors, and an audit record that failed to be written because of a scope is
 *   an audit record that does not exist.
 *
 * Anything else should be scoped.
 */
export function withSystemScope<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ state: { mode: 'system', reason } }, fn);
}

/** Thrown when a tenant-scoped model is queried with no scope resolved. */
export class MissingTenantScopeError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
  ) {
    super(
      `Query ${model}.${operation} ran with no tenant scope. Either it belongs inside a ` +
        'request (where the auth guard resolves one), or it is deliberately cross-tenant and ' +
        'belongs inside withSystemScope("why").',
    );
    this.name = 'MissingTenantScopeError';
  }
}

/** Thrown when a write would place a row in a tenant the caller cannot reach. */
export class CrossTenantWriteError extends Error {
  constructor(
    readonly model: string,
    readonly tenantId: string,
  ) {
    super(`Refused to write ${model} into tenant ${tenantId}, which is out of scope.`);
    this.name = 'CrossTenantWriteError';
  }
}

// ---------------------------------------------------------------------------
// Which models are scoped, and how
// ---------------------------------------------------------------------------

type ScopeFilter = (tenantIds: string[]) => Record<string, unknown>;

/**
 * The filter injected for each tenant-scoped model.
 *
 * A function per model rather than one `tenantId` rule, because the column is
 * not always the right thing to filter on:
 *
 * - `Tenant` is scoped by its own primary key.
 * - `RoleAssignment` carries a denormalised `tenantId` that is **null** for a
 *   GLOBAL grant, so filtering on it would expose every MSP-wide grant to every
 *   tenant. The meaningful question is whose account the grant is on, so it is
 *   filtered through the user.
 * - `Role` and `Credential` are legitimately installation-wide when their
 *   `tenantId` is null — a system role belongs to everyone — so null is visible.
 * - `AuditEvent` is the opposite: a null tenant there means an installation-level
 *   event, such as an MSP administrator signing in, which a customer has no
 *   business reading.
 *
 * A model absent from this list is not tenant-scoped and passes through
 * untouched. That is a deliberate decision each time, not an oversight: adding a
 * model with a `tenantId` and forgetting to add it here is caught by
 * `tenancy.spec.ts`, which reads the Prisma schema and fails on any tenant
 * column that is not accounted for.
 */
const TENANT_SCOPED: Record<string, ScopeFilter> = {
  Tenant: (ids) => ({ id: { in: ids } }),
  Site: (ids) => ({ tenantId: { in: ids } }),
  User: (ids) => ({ tenantId: { in: ids } }),
  RoleAssignment: (ids) => ({ user: { tenantId: { in: ids } } }),
  Role: (ids) => ({ OR: [{ tenantId: null }, { tenantId: { in: ids } }] }),
  Credential: (ids) => ({ OR: [{ tenantId: null }, { tenantId: { in: ids } }] }),
  AuditEvent: (ids) => ({ tenantId: { in: ids } }),

  // Phase 4 inventory. Every one of these carries a non-null tenant, so the
  // rule is the plain one — and every one of them is a row describing somebody
  // else's infrastructure, which is the thing this layer exists for.
  Cluster: (ids) => ({ tenantId: { in: ids } }),
  Node: (ids) => ({ tenantId: { in: ids } }),
  NodeStorage: (ids) => ({ tenantId: { in: ids } }),
  NodeInterface: (ids) => ({ tenantId: { in: ids } }),
  Workload: (ids) => ({ tenantId: { in: ids } }),
  CephDaemon: (ids) => ({ tenantId: { in: ids } }),
  DiscoveryRun: (ids) => ({ tenantId: { in: ids } }),
};

/** Models whose `tenantId` on a create must be inside the scope. */
const TENANT_COLUMN: Record<string, 'required' | 'optional'> = {
  Site: 'required',
  User: 'required',
  Role: 'optional',
  Credential: 'optional',
  AuditEvent: 'optional',
  Cluster: 'required',
  Node: 'required',
  NodeStorage: 'required',
  NodeInterface: 'required',
  Workload: 'required',
  CephDaemon: 'required',
  DiscoveryRun: 'required',
};

export const tenantScopedModels = (): string[] => Object.keys(TENANT_SCOPED).sort();

/** Operations whose `where` is filtered. */
const FILTERED_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
  'update',
  'delete',
  'upsert',
]);

/** Operations carrying a `data` payload whose tenant column has to be checked. */
const WRITING_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
]);

type QueryArgs = {
  where?: unknown;
  data?: unknown;
  create?: unknown;
  update?: unknown;
} & Record<string, unknown>;

/**
 * Combine the caller's `where` with the scope filter.
 *
 * The scope goes into `AND` while the caller's own keys stay at the top level,
 * and that arrangement is load-bearing in both directions.
 *
 * Wrapping the whole thing — `{AND: [callersWhere, scope]}` — reads better and
 * breaks `findUnique`, `update` and `delete`: Prisma requires a unique field at
 * the *top level* of their `where`, and moving `{id}` inside an `AND` produces
 * "Argument where needs at least one of id or email arguments". Learned by doing
 * it that way first.
 *
 * Appending to `AND` rather than assigning it matters too: a caller who already
 * passed an `AND` would otherwise have it silently replaced by the scope, which
 * would *widen* their query. Top-level keys are combined with AND by Prisma, so
 * a caller's `OR` sitting beside the scope's `AND` still means "their condition
 * and ours".
 */
function withFilter(where: unknown, filter: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> =
    where && typeof where === 'object' ? { ...(where as Record<string, unknown>) } : {};

  const existing = base.AND;
  base.AND =
    existing === undefined
      ? [filter]
      : Array.isArray(existing)
        ? [...existing, filter]
        : [existing, filter];

  return base;
}

function assertWritableTenant(model: string, data: unknown, scope: TenantScope): void {
  if (scope.kind === 'all' || data === undefined || data === null) return;
  const column = TENANT_COLUMN[model];
  if (!column) return;

  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const tenantId = (row as { tenantId?: unknown }).tenantId;

    if (typeof tenantId === 'string') {
      if (!scope.tenantIds.includes(tenantId)) throw new CrossTenantWriteError(model, tenantId);
      continue;
    }

    /*
     * A connect-style write (`tenant: { connect: { id } }`) says the same thing
     * in a different shape, and it would otherwise slip past.
     */
    const relation = (row as { tenant?: { connect?: { id?: unknown } } }).tenant;
    const connected = relation?.connect?.id;
    if (typeof connected === 'string' && !scope.tenantIds.includes(connected)) {
      throw new CrossTenantWriteError(model, connected);
    }
  }
}

/**
 * The whole decision, as one pure function.
 *
 * Extracted from the extension so it can be tested without a database, a Prisma
 * client or a running server — the same reason `isAllowed` in `@velnox/shared`
 * is a pure function. What it returns is the arguments the query should actually
 * run with; what it throws is a refusal.
 */
export function scopeQueryArgs(model: string, operation: string, args: unknown): unknown {
  const filterFor = TENANT_SCOPED[model];
  if (!filterFor) return args;

  const state = currentTenancy();

  if (!state || state.mode === 'unresolved') {
    throw new MissingTenantScopeError(model, operation);
  }

  if (state.mode === 'system') return args;

  const scope = state.scope;
  const next: QueryArgs = { ...((args ?? {}) as QueryArgs) };

  if (WRITING_OPERATIONS.has(operation)) {
    // `upsert` carries two payloads and either of them could move a row out of
    // the scope, so both are checked.
    assertWritableTenant(model, next.data, scope);
    assertWritableTenant(model, next.create, scope);
    assertWritableTenant(model, next.update, scope);
  }

  if (scope.kind === 'all') return next;

  /*
   * An empty scope is not "no filter" — it is "nothing". Someone whose grants
   * resolve to no tenant at all must see no rows, and `{ in: [] }` is exactly
   * that in Prisma, so this needs no special case. It is worth saying out loud
   * because the bug it avoids is the expensive one.
   */
  if (FILTERED_OPERATIONS.has(operation)) {
    next.where = withFilter(next.where, filterFor(scope.tenantIds));
  }

  return next;
}

/**
 * The Prisma client extension.
 *
 * Attached by `createPrismaClient`, which is the only place a client is built —
 * so there is no way to obtain an unextended client by accident.
 */
export const tenancyExtension = Prisma.defineExtension({
  name: 'velnox-tenancy',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        /*
         * The cast is back to the type this callback was handed. `query` is
         * typed as the union of every model's argument shape, so a rebuilt
         * object cannot satisfy it structurally — but this only ever rewrites a
         * `where`, never the operation.
         */
        return query(scopeQueryArgs(model, operation, args) as typeof args);
      },
    },
  },
});
