# OpenPPWR Architecture

Status: baseline architecture, implemented. The applications (`apps/api`, `apps/web`, `apps/worker`) and the migrated database (`packages/database`) exist and are exercised end to end.

## Product boundary

- Community: complete self-hosted reference workflow, public contracts, basic transparent rules.
- Cloud: managed operation and tenant lifecycle; private operations.
- Enterprise: commercial identity, controls, support and private deployment capabilities.
- Connect: public canonical integration contracts plus private connectors.
- Regulatory: maintained commercial content; Community receives small transparent demonstration pack.

Commercial source/content must never enter Community public export.

## Runtime target

```text
web -> API -> PostgreSQL
          -> evidence storage
worker -> PostgreSQL durable queue
       -> malware scanner / notification adapters
```

Tenant/actor context enters through verified authentication, is set transaction-locally, and is enforced again by FORCE RLS. Database triggers append audit events. Assessment snapshots reference immutable rule versions and evidence. Dossier generation consumes frozen review snapshot, never live mutable state.

## Current package mapping

| Folder | Conceptual boundary | Status |
|---|---|---|
| `packages/compliance-core` | `core` ports | Extracted baseline; use only with real consumers |
| `packages/packaging-master` | `packaging-domain` | Reusable mass/version logic |
| `packages/supplier-evidence` | `evidence` domain | Reusable workflow/manifest/ZIP primitives |
| `packages/security` | shared HTTP security | Reusable baseline |
| `packages/observability` | structured logging | Reusable baseline |
| `packages/reconciliation` | integration reconciliation | Future Connect consumer |
| `packages/assessment` | versioned assessment and gap domain | Implemented |
| `packages/dossier` | deterministic JSON/PDF/ZIP/checksum artifacts | Implemented; PDFs embed a Unicode font and localized EN/PL/DE output is verified |
| `packages/database` | migrations, roles and row-level security | Implemented |
| `packages/testing` | shared test fixtures and helpers | Internal |

Evidence storage is not a separate package; the API and worker read and write the shared private evidence
volume directly through tenant-confined path resolution.

Further packages will be added only with tests and ADRs where boundaries change.

## Deployment boundary

One tenant per deployment. Community Public Beta serves exactly one tenant per installed stack: `/v1/bootstrap`
refuses to create a second, and the worker refuses to start — and, on a periodic recheck, refuses to keep
working — when the database holds more than one. The boundary is enforced, not merely documented, because a
worker holding one tenant's identity would silently leave every other tenant's evidence pending. The data model
itself stays tenant-aware with row-level security throughout, so this is a supported-topology limit rather than
a schema limit. See [tenancy model](TENANCY_MODEL.md).

## Mandatory invariants

- One tenant per deployment; multi-tenant databases are refused at startup.
- No client-selected tenant context.
- One transaction per write use case.
- Idempotency keys scoped by tenant and operation.
- No release-path in-memory persistence.
- No evidence approval before clean malware result.
- No assessment without exact rule version and input/evidence snapshots.
- No gap deletion; closure/reopening is auditable.
- No dossier from unfrozen/live state.
