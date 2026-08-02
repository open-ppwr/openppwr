// The canonical permission registry.
//
// `tenant_admin` used to be stored as `['*']`, and that single character was the whole defect.
// A wildcard does not grant "everything an administrator should have"; it
// grants *whatever the string set happens to contain at the time it is evaluated*. Three consequences,
// all of them real in this repository before this file was rewritten:
//
//   1. `scan:process` — the worker's machine-only permission — was held by `tenant_admin`, so a human
//      administrator could claim scan jobs. `docs/security/AUTHORIZATION_MATRIX.md` said `-` for that
//      cell. The document was right and the code was wrong, and nothing compared them.
//   2. `scan:requeue` existed on two routes and in no role's list, so it was reachable *only* through
//      the wildcard. `scripts/validation/permission-matrix-gate.mjs` never noticed, because it reads the
//      union of the role lists and `scan:requeue` was in none of them. An undocumented permission with
//      exactly one holder, by accident.
//   3. Any permission added in future would be granted to `tenant_admin` silently, by a maintainer who
//      never considered whether an administrator should hold it.
//
// So assignment is now declared here, per permission, next to the audience and edition that decide
// whether it may be held by a human at all. The role lists are *derived* from this table, which means
// there is one place to look and one place to change. A new permission with no `roles` and no
// `unassigned` reason fails the drift test in `test/permissions.test.mjs` — the registry cannot grow
// without someone stating who holds the new entry.
//
// Fields:
//   audience — `human` (an interactive user may hold it), `machine` (a background process credential
//              only), `system` (platform-level, outside a tenant's authority).
//   scope    — `tenant` (acts within one tenant) or `global` (crosses tenants). Community has no
//              `global` permission; the field exists so that adding one is a visible decision.
//   edition  — `community` here. A permission belonging to a commercial edition must never be granted
//              by this file, and `assertRegistryIsSound` refuses it.
//   roles    — the exact roles that hold it. No inheritance, no wildcard, no implication.
const PERMISSION_REGISTRY = Object.freeze({
  read: {
    audience: 'human', scope: 'tenant', edition: 'community',
    roles: ['tenant_admin', 'compliance_manager', 'packaging_editor', 'evidence_contributor', 'evidence_reviewer', 'read_only_auditor', 'service_account'],
  },
  // Deliberately not held by `tenant_admin`: `read-own` is a *narrowing* of `read` for a supplier, and a
  // role holding both would make the narrower grant meaningless. Routes accept either.
  'read-own': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['supplier_user'] },
  'packaging:write': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin', 'compliance_manager', 'packaging_editor'] },
  'evidence:upload': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin', 'evidence_contributor', 'supplier_user'] },
  'evidence:review': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin', 'evidence_reviewer'] },
  'evidence:download': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin', 'evidence_reviewer', 'read_only_auditor'] },
  'evidence:download-own': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['evidence_contributor', 'supplier_user'] },
  'assessment:run': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin', 'compliance_manager', 'service_account'] },
  'gap:manage': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin', 'compliance_manager'] },
  'review:freeze': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin', 'compliance_manager'] },
  // dossier:download accompanies dossier:generate. A role that freezes the review and produces the
  // dossier but cannot retrieve the package it just generated has an authorisation gap, not a
  // safeguard: the artifact contains only data the role already reads, and download stays
  // tenant-scoped and audited. audit:verify is here for the same reason — confirming that the record
  // behind a frozen review was not altered is part of running the review.
  'dossier:generate': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin', 'compliance_manager', 'service_account'] },
  'dossier:download': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin', 'compliance_manager', 'read_only_auditor', 'service_account'] },
  'audit:verify': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin', 'compliance_manager', 'read_only_auditor'] },
  // The operator remedy for a scan job that reached its terminal state. An administrative
  // human action on infrastructure, held by the tenant administrator and by nobody else — in
  // particular not by the worker, which must never resurrect the job it failed to process.
  'scan:requeue': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin'] },
  // Replacing *somebody else's* bearer credential. Held by the tenant administrator and by nobody else,
  // because it is an account-recovery act on another person's behalf: the holder ends every session that
  // identity has and hands out the credential that replaces it.
  //
  // It deliberately does not cover replacing your own. That is `mayRotateCredential` below, and it is not a
  // permission at all — see the reasoning there.
  'credential:rotate': { audience: 'human', scope: 'tenant', edition: 'community', roles: ['tenant_admin'] },
  // Machine-only, and the reason this file exists. `audience: 'machine'` is not decoration: the
  // administrator derivation and `assertRegistryIsSound` both refuse to hand it to a human role.
  'scan:process': { audience: 'machine', scope: 'tenant', edition: 'community', roles: ['worker'] },
});

// Declaration order is the API's presentation order, so it is fixed here rather than left to
// `Object.keys` on a table someone reorders later.
const ROLE_ORDER = Object.freeze([
  'tenant_admin', 'compliance_manager', 'packaging_editor', 'evidence_contributor',
  'evidence_reviewer', 'read_only_auditor', 'supplier_user', 'service_account', 'worker',
]);

// Roles a human signs in as. The separation is what makes `audience` enforceable: a machine permission
// granted to any of these is a defect the soundness check refuses, not a judgement call.
const HUMAN_ROLES = Object.freeze(['tenant_admin', 'compliance_manager', 'packaging_editor', 'evidence_contributor', 'evidence_reviewer', 'read_only_auditor', 'supplier_user']);
const MACHINE_ROLES = Object.freeze(['service_account', 'worker']);

// The registry is checked at import time, not by a test alone. A test proves the table was sound when
// the suite last ran; this proves it is sound in the process that is about to authorise requests.
export function assertRegistryIsSound(registry = PERMISSION_REGISTRY, { roleOrder = ROLE_ORDER, humanRoles = HUMAN_ROLES } = {}) {
  const problems = [];
  for (const [permission, entry] of Object.entries(registry)) {
    if (permission === '*') problems.push('the registry must not contain a wildcard permission');
    if (!['human', 'machine', 'system'].includes(entry.audience)) problems.push(`${permission} has no valid audience`);
    if (!['tenant', 'global'].includes(entry.scope)) problems.push(`${permission} has no valid scope`);
    if (entry.edition !== 'community') problems.push(`${permission} belongs to edition "${entry.edition}" and must not be granted by the Community registry`);
    const roles = entry.roles || [];
    // The drift guard. Adding a permission without stating who holds it fails here, so the "assign it
    // later" path — the one that produced `scan:requeue` — is closed.
    if (!Array.isArray(roles)) problems.push(`${permission} has no roles array`);
    else if (roles.length === 0 && !entry.unassigned) problems.push(`${permission} is assigned to no role and gives no "unassigned" reason`);
    // Every role in this product acts inside one tenant, so a `global` permission has no holder here.
    // Declaring one is legitimate — it just cannot be assigned by the Community registry.
    if (entry.scope === 'global' && roles.length > 0) problems.push(`${permission} is global in scope and cannot be held by a tenant role`);
    for (const role of roles) {
      if (!roleOrder.includes(role)) problems.push(`${permission} is assigned to unknown role "${role}"`);
      if (entry.audience !== 'human' && humanRoles.includes(role)) problems.push(`${permission} is ${entry.audience}-only but is assigned to human role "${role}"`);
    }
  }
  if (problems.length) throw new Error(`Permission registry is unsound: ${problems.join('; ')}`);
  return true;
}

assertRegistryIsSound();

// Inverted from the registry, so the role lists cannot disagree with the assignments above.
export function derivePermissions(registry = PERMISSION_REGISTRY, roleOrder = ROLE_ORDER) {
  return Object.freeze(Object.fromEntries(roleOrder.map((role) => [
    role,
    Object.freeze(Object.keys(registry).filter((permission) => (registry[permission].roles || []).includes(role))),
  ])));
}

const permissions = derivePermissions();

// The permissions a role actually holds, for a client that must decide what to offer. Presenting an
// action that is certain to be refused is how the audit-chain and dossier-download defects reached
// users: the interface invited an operation the server would never allow. This is a convenience for
// presentation only — every request is still authorised server-side.
//
// It no longer expands anything. The list it returns *is* the list `isAllowed` consults, so the two can
// no longer differ; the old wildcard branch computed a union over every role, which is why
// `tenant_admin` reported `scan:process`.
export function permissionsFor(role) {
  return [...(permissions[role] || [])];
}

export function isAllowed(identity, permission, resource = {}) {
  // Unknown permission denied, and `*` denied as a permission *name*. Nothing in this product stores a
  // role or permission outside this file, but a permission string that reaches here from a route typo,
  // a future configuration surface or a persisted value must fail closed rather than match something.
  if (typeof permission !== 'string' || !Object.hasOwn(PERMISSION_REGISTRY, permission)) return false;
  const granted = permissions[identity?.role] || [];
  if (!granted.includes(permission)) return false;
  if (identity.role === 'supplier_user' && resource.supplierId && identity.supplierId !== resource.supplierId) return false;
  return true;
}

// Who may replace whose bearer credential. Stated here, next to the registry, rather than left implicit in
// the route that happens to call it — a rule that lives in a route is a rule the next route will not know
// about, which is how `scan:requeue` came to exist on two routes and in no role's list.
//
// Two ways to qualify, and they are different in kind:
//
//   1. **Your own.** Not a permission, and deliberately not one. The caller has already proved possession of
//      the credential by presenting it, and it grants them everything the replacement will; refusing would
//      only mean an identity whose token leaked cannot fix it without an administrator, which is the failure
//      this capability exists to remove. A permission that every role must hold is not a boundary, and one
//      that some role could be denied would be a trap.
//   2. **Somebody else's.** `credential:rotate`, held by the tenant administrator. This is the account
//      recovery path, and it is an authority over another identity, so it is named, assigned and auditable
//      like every other authority in the registry.
//
// This is the route's check. It is not the boundary: `rotate_openppwr_identity_credential` (migration 034)
// applies the same rule against the credential the database itself resolved, so bypassing this function
// changes nothing. Both are here because a refusal a caller can reach without a database round trip is a
// better refusal, not because either is sufficient alone.
export function mayRotateCredential(identity, targetIdentityId) {
  if (!identity?.actorId || typeof targetIdentityId !== 'string' || !targetIdentityId) return false;
  if (identity.actorId === targetIdentityId) return true;
  return isAllowed(identity, 'credential:rotate');
}

export function requirePermission(identity, permission, resource) {
  if (!isAllowed(identity, permission, resource)) {
    throw Object.assign(new Error('Resource not found.'), { code: 'RESOURCE_NOT_FOUND', status: 404 });
  }
}

export const AUTHORIZATION_MATRIX = permissions;
export const PERMISSION_CATALOGUE = PERMISSION_REGISTRY;
export const SUPPORTED_ROLES = ROLE_ORDER;
export const HUMAN_ROLE_NAMES = HUMAN_ROLES;
export const MACHINE_ROLE_NAMES = MACHINE_ROLES;
