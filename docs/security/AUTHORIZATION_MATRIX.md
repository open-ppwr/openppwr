# Route Authorization Matrix

Status: implemented permission contract; route coverage grows with Phase 4 endpoints. Human security approval required.

Legend: `A` allowed, `S` allowed only for the identity's supplier, `-` denied. Denials use a non-disclosing not-found response when an object identifier is involved. PostgreSQL `FORCE RLS` remains mandatory after route authorization.

This table is written by hand, and `scripts/validation/permission-matrix-gate.mjs` now parses it and checks **every cell** against `apps/api/src/permissions.mjs`. Until 2026-07-30 that gate read the React component and the presentation matrix and never this file, while this file claimed otherwise — so a wrong cell in the document a human reader actually consults would have passed indefinitely. Verified not vacuous by mutation: changing one cell to claim the administrator processes scan jobs fails the gate by name. Until 2026-07-30 the tenant administrator was stored as the wildcard `*`, and two cells below were therefore wrong: this document said the administrator may not process scan jobs, and the code granted it. The wildcard is gone; the administrator now holds a named set.

| Capability | Tenant admin | Compliance manager | Packaging editor | Evidence contributor | Evidence reviewer | Read-only auditor | Supplier user | Service account | Worker |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| View tenant records | A | A | A | A | A | A | Own | A | - |
| Packaging import/write | A | A | A | - | - | - | - | - | - |
| Evidence upload | A | - | - | A | - | - | S | - | - |
| Evidence review | A | - | - | - | A | - | - | - | - |
| Evidence download | A | - | - | Own | A | A | S | - | - |
| Run assessment | A | A | - | - | - | - | - | A | - |
| Manage gaps/remediation | A | A | - | - | - | - | - | - | - |
| Freeze review snapshot | A | A | - | - | - | - | - | - | - |
| Generate dossier | A | A | - | - | - | - | - | A | - |
| Download dossier | A | A | - | - | - | A | - | A | - |
| Verify audit | A | A | - | - | - | A | - | - | - |
| Requeue a terminal scan job | A | - | - | - | - | - | - | - | - |
| Rotate another identity's credential | A | - | - | - | - | - | - | - | - |
| Process scan job | - | - | - | - | - | - | - | - | A |

## Identity boundary

- Identity, tenant, role and supplier scope originate only from a verified bearer credential hash.
- No client-selected identity or tenant header is accepted.
- Bootstrap is a one-time, separately authenticated operation and returns generated credentials once.
- Human review permissions are never granted to worker or service identities.
- The permission catalogue records an `audience` for every entry, and a `machine` or `system` permission assigned to a human role fails at import, not at review time. That is what makes the "never" above enforceable rather than aspirational.
- Requeuing a terminal scan job is a human administrative act (`scan:requeue`); processing one is a machine act (`scan:process`). They are separate permissions with disjoint holders, so the identity that failed a job cannot resurrect it.
- Adding a permission without stating which roles hold it fails `assertRegistryIsSound`. There is no default grant.
- Replacing a bearer credential has two qualifying routes and they differ in kind. **Your own** is not a permission and no role can be denied it: presenting the credential is proof of possession, and the holder already has everything the replacement grants. **Somebody else's** is `credential:rotate`, held by the tenant administrator alone, because it is an authority over another identity. `mayRotateCredential` in `apps/api/src/permissions.mjs` states the rule, and `rotate_openppwr_identity_credential` applies the same rule against the credential the database resolved itself, so the route check is the fast refusal rather than the boundary.
- Rotation replaces the credential and nothing else. The write names three columns — the digest, the expiry and the rotation time — so role, tenant and supplier scope cannot change through it by construction rather than by review.

