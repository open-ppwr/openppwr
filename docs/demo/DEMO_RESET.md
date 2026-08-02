# ACME demonstration reset

Returns the isolated ACME demonstration tenant to a clean state so the reference journey can be run
again from the beginning.

Command: `npm run demo:reset` (or `node scripts/acme/demo-reset.mjs`).

## Tenant-scoped mode, added 2026-07-30

The default path below `TRUNCATE`s the domain tables, and therefore refuses to run unless the database
holds exactly one tenant — on a multi-tenant deployment it would take every tenant's data with it. That
guard is correct and unchanged.

It also makes the default path unusable on the private deployment, which holds a demonstration tenant
and a synthetic isolation tenant. For that case:

```bash
OPENPPWR_DEMO_RESET_CONFIRM=yes node scripts/acme/demo-reset.mjs --tenant-slug=acme-eu-demo
```

Scoped mode deletes by `tenant_id` and then **proves** no other tenant's row counts changed, rather than
assuming it. It refuses any tenant that carries no synthetic-data disclaimer. Two further differences,
both deliberate:

- **Its own foreign-key ordering.** A scoped `DELETE` has no `CASCADE` to lean on.
  `gaps.current_assessment_id` references `assessments`, so gaps must be deleted first. The first
  attempt on the deployment failed on exactly this, inside a transaction, and rolled back with nothing
  lost — which is how the ordering came to be stated explicitly instead of inherited.
- **It preserves `audit_events`.** That table is append-only, and clearing a demonstration's business
  data should not erase the record that the demonstration happened.

### What the second point exposed

**Closed by migration `007_audit_truncate_guard.sql`.** This section previously described an open gap and
is kept, corrected, because the reasoning still explains why the guarantee needs two triggers rather than
one.

The original append-only guarantee was a `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger, and
PostgreSQL does not fire row triggers on `TRUNCATE` — there are no rows to iterate, so the trigger is
never consulted. `TRUNCATE audit_events` therefore removed the entire audit chain without objection,
including through the global path documented below.

Migration 007 adds the second trigger the guarantee was missing: `BEFORE TRUNCATE ... FOR EACH STATEMENT`,
which is the only kind `TRUNCATE` consults. Append-only now holds for row-level mutation *and* for
`TRUNCATE`, against every operation available to the OpenPPWR runtime roles and against standard database
operations.

The boundary is stated in the migration rather than overclaimed here: a fully privileged database
superuser can disable a trigger, and so remains outside it. That is a property of PostgreSQL, not
something this schema can close.

Verified on the deployment 2026-07-30:

```text
DEMO_RESET_SCOPED_PASS tenant=acme-eu-demo cleared_rows=659 audit_events_preserved=417
                       identities_preserved=9 other_tenants=1 collateral=none
```

## Safety model

This command deletes data. It is written to **fail closed**: it refuses to act on anything it cannot
positively identify as the fictional demonstration tenant, because the cost of being wrong is
destroying real compliance evidence.

It refuses to run when:

| Condition | Reason |
|---|---|
| `OPENPPWR_DEMO_RESET_CONFIRM=yes` is not set | Destructive actions require explicit intent, never a bare command |
| No database URL is configured | It will not guess a target |
| No tenant exists | Nothing to reset; the installer bootstrap has not run |
| **More than one tenant exists** | A multi-tenant database is by definition not an isolated demo database |
| The tenant slug is not the expected demonstration slug (`acme-eu-demo`) | It will not reset a tenant that may be real |
| The generated dataset fails validation | It will not restore a baseline it cannot verify |

`--dry-run` reports exactly what would happen and changes nothing. It requires no confirmation.

## What it clears, and what it deliberately keeps

Cleared, in one transaction, so a partially reset demo cannot exist: dossier artifacts, review
snapshots, assessment results, assessments, gaps, scan jobs, evidence files, evidence requirements,
BOM lines, BOMs, packaging, components, materials, suppliers, import runs and results, audit events.

**Kept: `tenants` and `identities`.** Bootstrap is a one-time, whole-deployment operation — the API
refuses it once a tenant exists, and credentials are stored only as hashes. Deleting identities
would therefore destroy credentials that cannot be reissued and would leave the deployment
unusable. The command verifies after the fact that identities survived and fails if they did not.

Schema and migrations are untouched.

## Usage

```sh
# Report what would happen. Safe, changes nothing.
node scripts/acme/demo-reset.mjs --dry-run

# Perform the reset.
OPENPPWR_DEMO_RESET_CONFIRM=yes \
OPENPPWR_DEMO_DATABASE_URL=postgres://... \
node scripts/acme/demo-reset.mjs
```

Then re-import the deterministic dataset through the normal import path, exactly as a user would:
the files produced by `npm run acme:export` are the same ones published on the demo page.

| Variable | Purpose |
|---|---|
| `OPENPPWR_DEMO_RESET_CONFIRM` | Must be `yes` to modify data |
| `OPENPPWR_DEMO_DATABASE_URL` | Target database; falls back to `OPENPPWR_MIGRATION_DATABASE_URL` |
| `OPENPPWR_DEMO_TENANT_SLUG` | Expected demonstration slug, default `acme-eu-demo` |

## Output

Success reports the tenant, tables cleared, identities preserved, dataset seed, schema version,
generator version and the dataset checksum. Nothing sensitive is logged: no credential, no token, no
connection string.

## Idempotency

Running it twice is safe. The second run clears an already-clean tenant and succeeds, rather than
failing on absent rows.

## Tests

`scripts/acme/demo-reset.test.mjs` covers every refusal above, the dry run leaving data untouched, a
confirmed reset clearing domain data while preserving identities and the tenant, and a repeat run
succeeding.
