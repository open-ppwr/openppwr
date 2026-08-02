// The shape of the role and permission matrix, kept in plain JavaScript so that both the component
// that renders it and the gate that checks it can import the same definition.
//
// The gate (`scripts/validation/permission-matrix-gate.mjs`) fails the build when the server's
// permission registry contains a permission this file does not place and label, or when it places one
// the server does not grant. That is what stops a hand-maintained matrix drifting from the code that
// enforces it — the failure mode that made the previous prose description untrustworthy.

// The columns of the rendered matrix, which is a different list from "the roles a person signs in as" and
// must not be read as that one. It answers "whose grants does a reader need to see": `service_account`
// is here because it authenticates and holds four permissions an auditor has to be able to check, and it
// is *not* a sign-in role — `HUMAN_ROLES` in `apps/api/src/permissions.mjs` is the authority on that, and
// `release-contract-gate.mjs` read this list for that question until 2026-08-02 and therefore made the
// release contract state eight where the server said seven.
//
// `worker` is deliberately absent: it is the internal scanning identity, holds only `scan:process`, and
// nothing a person does is affected by its column. `permission-matrix-gate.mjs` names that omission
// explicitly rather than letting it pass unnoticed.
export const DISPLAY_ROLES = [
  'tenant_admin', 'compliance_manager', 'packaging_editor', 'evidence_contributor',
  'evidence_reviewer', 'supplier_user', 'read_only_auditor', 'service_account',
];

// Every permission the registry can return, grouped the way the work is actually divided.
//
// There is no `administration` group holding `*` any more. The administrator's authority is now the sum
// of the explicit cells below, which is both what the server enforces and what a reader can check
// against the server. While the wildcard existed, this page rendered one row labelled "Full tenant
// administration" that told the reader nothing and hid the fact that the administrator also held the
// worker's `scan:process`.
//
// `operations` is separate from `internal` on purpose: requeuing a terminal scan job is an
// administrative act by a person, while processing one is something only the worker identity does.
export const CAPABILITY_GROUPS = [
  { key: 'catalogue', permissions: ['read', 'read-own', 'packaging:write'] },
  { key: 'evidence', permissions: ['evidence:upload', 'evidence:review', 'evidence:download', 'evidence:download-own'] },
  { key: 'assessment', permissions: ['assessment:run', 'gap:manage'] },
  { key: 'review', permissions: ['review:freeze', 'dossier:generate', 'dossier:download'] },
  { key: 'audit', permissions: ['audit:verify'] },
  { key: 'operations', permissions: ['scan:requeue', 'credential:rotate'] },
  { key: 'internal', permissions: ['scan:process'] },
];

export const PLACED_PERMISSIONS = CAPABILITY_GROUPS.flatMap((group) => group.permissions);
