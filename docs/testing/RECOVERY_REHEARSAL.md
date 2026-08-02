# Community recovery rehearsal

Status: **offline backup/restore and migration-idempotency PASS in isolated local PostgreSQL test harness, now with two tenants present; versioned upgrade/rollback remains open**.

## Task contract

- Scope and boundaries: Community database, matching private evidence storage, idempotent migrations, health check, RLS negative check, audit reconstruction and restore-based rollback. No production or customer system is touched.
- Acceptance: synthetic ACME state and evidence survive an offline snapshot/restore; manifests match before startup; migrations remain idempotent; candidate writes alter persisted state; restoring the original snapshot recovers exact counts and valid audit chain.
- Forbidden changes: customer data, manual release-path SQL, destructive down-migrations, credentials in reports, production deployment or a claim that local evidence proves container/managed-database recovery.
- Tests and negative tests: persisted packaging records per tenant; evidence file manifest; audit verification; zero runtime rows without tenant context; zero rows of another tenant visible to either; a cross-tenant read refused after restore; each worker confined to its own tenant's queue; post-upgrade assessments absent after rollback.
- Exact validation command: `npm run release:recovery` or `node scripts/release/rehearse-recovery.mjs`.
- Migration/deployment/rollback: two existing migrations are applied and reapplied idempotently; the validated offline snapshot is restored after candidate writes. No N-1 binary/schema is exercised, so versioned upgrade/rollback remains a separate hard gate.
- Impact: synthetic data only; tenant RLS and audit history are verified; no regulatory or i18n wording changes.

## Executed evidence — 2026-07-28

Environment: Windows release workstation, Node.js `v24.16.0`, isolated embedded PostgreSQL 18 test cluster. Latest rerun duration: `43.349s`. Generated report: ignored runtime artifact `artifacts/release/recovery-rehearsal-report.json`.

Results:

- backup: 1,376 database files / 68,122,067 bytes plus one 42-byte synthetic evidence file; SHA-256 aggregate manifests created;
- pre-backup state: one tenant, 32 packaging records, four audit events, zero assessments, two migrations;
- restore: both manifests matched before startup; state counts matched; audit chain valid;
- migration/forward smoke: migration reapplication changed no migration count; `/health` returned 200; real assessment writes created 32 assessments and 36 audit events;
- same-version snapshot recovery: original database and evidence snapshots restored after candidate writes; `/health` returned 200; audit chain valid; exact original counts restored;
- RLS negative check: runtime identity without tenant context saw zero packaging rows before backup, after restore, after upgrade and after rollback.

Limits: this proves a real offline PostgreSQL/evidence snapshot workflow and idempotent current migrations in an isolated test harness. It does not prove N-1-to-candidate upgrade, candidate-to-N-1 rollback, immutable container rollback, production PostgreSQL tooling or an independent environment rehearsal.

## Two tenants — 2026-08-01

Every rehearsal above ran with one tenant, and a restore that puts one tenant's rows back cannot show that
it did not merge two. Tenant isolation was proven for the request path by the two-tenant matrices; the
restore path and the background-job path had never been exercised where there was another tenant to confuse
them with. The rehearsal now runs with two.

The second tenant is created by `scripts/acme/provision-synthetic-tenant.mjs`, because `POST /v1/bootstrap`
refuses to run twice, and its worker credential is issued by `scripts/acme/issue-worker-token.mjs`, because
an identity's bearer token is stored as a hash and the plaintext is never kept. Both are what the product
ships for these jobs, and both are run as separate processes with their own connection strings, exactly as
an operator would run them. The two tenants deliberately hold **different** row counts — 32 packaging
records against 28 — so that a restore which merged or swapped them cannot produce numbers that still add up.

Duration `35.355s`. Results:

- **backup with two tenants:** 1,406 database files / 68,834,772 bytes, two evidence files / 93 bytes, SHA-256 aggregate manifests;
- **restore:** both manifests matched before startup; totals matched; and the per-tenant breakdown matched — 32/1/1 and 28/1/1 packaging, evidence files and scan jobs — which is the comparison a merged restore would fail while the totals still passed;
- **row scoping after restore:** asked through the request-serving credential, which is `NOBYPASSRLS`, with the tenant identifier set on the connection. Each tenant saw its own rows and **zero** rows belonging to the other, for packaging and for audit events; the two tenants' audit events add up to the whole restored record exactly once;
- **cross-tenant read after restore:** the first tenant's auditor credential reaching for a **real** packaging identifier belonging to the second tenant received `404`;
- **evidence files:** both restored under their owning tenant's directory, each storage key scoped to its own tenant;
- **credentials across the backup:** sessions issued before the backup still authenticated against the restored deployment;
- **worker startup guard:** with two tenants present the worker refuses to start, `WORKER_MULTI_TENANT_DEPLOYMENT_UNSUPPORTED`, which is the supported behaviour and is asserted before anything else in this section;
- **worker isolation, with that refusal overridden:** each worker saw exactly one pending job — its own tenant's. The first tenant's worker processed its own job, then found nothing more, and the second tenant's job was still pending and untouched; the second tenant's worker then processed it. Both jobs ended up completed under the tenant that owned them;
- **rollback:** the snapshot restored both tenants, both audit records whole, and both scan jobs pending again.

### A finding this raised, and it is not about recovery

Aiming to show each tenant's audit chain verifying on its own established that it cannot, for a reason that
has nothing to do with backup or restore: **the hash chain is one global sequence while verification is
tenant-scoped.** Each new event links to the previous event in the whole table — the linking query carries
no tenant predicate and runs as a definer function owned by a role that bypasses row-level security — while
`GET /v1/audit/verify` walks one tenant's rows through row-level security and starts from the genesis value.
So the second tenant's first event carries the first tenant's last hash, and the second tenant's own
verification reports `valid: false` at that event with nothing tampered.

This is a consequence of the one-tenant-per-deployment scope rather than a defect inside it: bootstrap
refuses a second tenant and the worker refuses to start against one, so a supported deployment never reaches
this state. A demonstration stack provisioned with the shipped script does reach it, and an operator being
told the record is broken when it is not is not an acceptable answer to leave undocumented. The rehearsal
asserts the exact mechanism — that the second tenant's earliest event links to an event belonging to the
first tenant, and that verification stops at precisely that event and nowhere else — and reports it as a
finding on its own console line and in its JSON report. What the rehearsal claims about the restore is the
claim the restore can support: verification answers exactly what it answered before the backup, for both
tenants, including where it stops.

### What these checks are worth

Each was broken deliberately and observed to fail:

- removing the tenant identifier from the scoping check made the connection see **0** rows instead of 32, because every tenant table is `FORCE ROW LEVEL SECURITY` and a connection with no tenant set sees nothing;
- making the per-tenant counts count every tenant's rows produced `[28, 32]` against an observed `[60, 60]` and failed the comparison — the totals were unchanged throughout, which is the point of comparing per tenant;
- two attempts to simulate a misfiled restore by moving one row to the other tenant were refused by the schema itself: `packaging` has a composite primary key of `(tenant_id, id)` and the two tenants share ACME identifiers, so the move collided; `evidence_files` is referenced by `scan_jobs` through a composite foreign key carrying `tenant_id`, so a row cannot change tenant while its dependents do not. Both refusals are stronger evidence than the mutation would have been.

Limits, in addition to those above: the second tenant exists only because the worker's single-tenant startup
guard was overridden with the option its own comment reserves for verification suites, so this run says what
a two-tenant database does and is not evidence that a two-tenant deployment is supported. The backup is a
physical snapshot of a stopped cluster plus its evidence directory; it is not the installer's encrypted
backup set, and nothing here exercises encryption or off-host copying.
