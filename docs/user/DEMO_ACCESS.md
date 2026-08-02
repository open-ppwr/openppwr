# Signing in to the OpenPPWR workbench

The workbench offers an email-and-password sign-in for the demonstration environment, and an
access-token option for operators.

## How sign-in works

Signing in with email and password returns a **bearer session token** which the browser tab holds in
memory. No cookie is ever set, so cross-site request forgery does not apply, and the session expires
on its own — something the bootstrap-issued role tokens never did.

Demonstration accounts are **opt-in and off by default**. A deployment holding real data must never
start with a known password, so the operator enables them explicitly with `OPENPPWR_DEMO_LOGIN=true`,
and may set the password and mail domain.

## Signing in with email and password

Open `/pl/app`, `/en/app` or `/de/app`. When demonstration sign-in is enabled the page shows a
**Demonstration accounts** panel listing one card per role: what that role is for, its address, and a
button that fills the form in. The shared password is printed on the same panel.

The credentials are shown deliberately. A demonstration nobody can sign in to is not a demonstration,
and hiding a password that is written in the deployment documentation protects nothing. The panel
exists only because the operator set `OPENPPWR_DEMO_LOGIN=true`, which they may only do on a
deployment holding fictional data. With demo sign-in off, the endpoint that supplies the panel does
not exist, so a real deployment discloses nothing — not even that the feature is absent.

Start with **compliance manager**: it is the only role that can walk the whole workflow from import to
dossier.

On a deployment set up with `openppwr-installer bootstrap-acme` there is already something to look at.
The ACME catalogue is imported, one supplier declaration per supplier is uploaded, scanned and
accepted, and an assessment has been run. Two gaps are open on purpose — a packaging record declaring
5% recycled content against a 30% minimum, and one declaring none — and closing them is what makes the
review freezable and the dossier reachable. See
[the reference workflow](REFERENCE_WORKFLOW.md) for the numbers a fresh deployment starts with.

The password is set by the operator with `OPENPPWR_DEMO_PASSWORD`. The listed roles are the
interactive ones; `service_account` and `worker` authenticate but have no interactive purpose, so no
password account is created for them at all — not merely left off the panel. Until 2026-08-02 bootstrap
created one for every role and offered seven, so those two identities held the published password at a
predictable address that nothing advertised. A deployment bootstrapped before that date still held those
accounts; migration `039` deletes them and makes sign-in refuse a machine role in the database, so the
password stops working even where the account was restored from a backup or written back by hand. The
bearer tokens listed below are unaffected — they are how those identities are meant to authenticate.

If sign-in accounts were never provisioned — for a deployment created before this feature existed —
the operator runs:

```sh
OPENPPWR_DEMO_LOGIN=true OPENPPWR_DEMO_RESET_CONFIRM=yes OPENPPWR_DEMO_DATABASE_URL=postgres://... npm run demo:login:provision
```

Bootstrap normally creates these accounts, but bootstrap is a one-time operation, so an older
deployment needs this one command.

## Resetting the environment

Once signed in with a role that may manage the tenant, the workbench offers **Reset environment to
initial state**. It deletes the imported packaging, evidence, assessments, gaps and dossiers in that
environment, and deliberately preserves the tenant, identities and sign-in accounts, so the reset
cannot lock you out of the environment it just restored.

"Initial state" means **empty**, not the state `bootstrap-acme` set up. Nothing re-seeds the
demonstration afterwards: bootstrap is a one-time, whole-deployment operation and cannot be run again
against an existing tenant. After a reset, rebuild the environment by hand — import
`acme-import-valid.json` from the Downloads page, upload and accept supplier evidence, then run the
assessment. Reset only when that is what you want.

## The access-token option, for operators

## Retrieving the credentials (operator)

On the deployment host, as root:

```sh
OPENPPWR_SHOW_CREDENTIALS=yes openppwr-installer credentials
```

Without the environment variable the command refuses and explains why. These are bearer credentials
that grant full access to the tenant, so they are never printed as a side effect of another command.

The output lists one token per role:

```
tenant_admin          opp_test_…
compliance_manager    opp_test_…
packaging_editor      opp_test_…
evidence_contributor  opp_test_…
evidence_reviewer     opp_test_…
read_only_auditor     opp_test_…
supplier_user         opp_test_…
service_account       opp_test_…
worker                opp_test_…
```

Run it where nobody can read the screen, and do not paste the output into chat, tickets or email.

## Which role to use

| Goal | Role |
|---|---|
| Walk the full workflow: import, assess, remediate, freeze, generate a dossier | `compliance_manager` |
| Look at everything without changing anything | `read_only_auditor` |
| Import packaging data only | `packaging_editor` |
| Upload supplier evidence | `evidence_contributor` |
| Accept or reject evidence | `evidence_reviewer` |
| See the supplier-scoped view | `supplier_user` |
| Requeue a dead scan job | `tenant_admin` |

`worker` and `service_account` are machine identities. They work in the interface but are not
intended for interactive use.

## Signing in

1. Open `/pl/app`, `/en/app` or `/de/app`.
2. Paste the token into **Dane dostępowe / Access credential**.
3. Press **Zweryfikuj dane dostępowe / Verify credential**, or Enter.
4. The panel confirms the signed-in role and tenant, and the workflow actions become available.

If the credential is wrong the panel says so and explains the likely causes. It does not show a raw
error object.

## If a credential stops working

The most common cause is that the tenant was rebuilt — for example after `demo:reset` followed by a
fresh bootstrap — which invalidates every previously issued token. Retrieve the current ones with the
command above.

## Rotation

**A credential can be replaced in place.** `POST /v1/identities/{id}/rotate-credential` returns the
replacement once, ends every session the identity holds, and records the change in the audit chain.
Resetting the tenant — which discards its data — is not the remedy for an exposed credential and never
needs to be.

```sh
curl -X POST -H "authorization: Bearer <your token>" \
  http://127.0.0.1:31114/v1/identities/<identity id>/rotate-credential
```

Any identity may replace its own credential, because presenting it is proof of possession. A tenant
administrator may replace any credential in the tenant, which is the recovery path when the holder
cannot act; anything else is answered as a not-found. Capture the replacement before you close the
terminal: tokens are stored only as hashes, so nothing can show it again — which is also why the old
one could never have been read back either.

The route needs `OPENPPWR_ROTATION_DATABASE_PASSWORD` to be set, which a deployment holding real data
is meant to set. Without it the route answers `404` and the only remaining path is the migration
credential on the host. Bootstrap remains a one-time, whole-deployment operation: rotation replaces a
credential, it does not issue a new identity.

Resetting the demonstration data and bootstrapping again issues an entirely new set, and remains
available for a demonstration tenant of fictional ACME data:

```sh
OPENPPWR_DEMO_RESET_CONFIRM=yes npm run demo:reset
```

## Security notes

- The credential lives only in the browser tab. It is not written to `localStorage`, not persisted,
  and never sent to a third party.
- No cookie is set by the application, which is why CSRF does not apply.
- Cloudflare Access, where present, authenticates you at the edge only. It grants **no** application
  privilege: an Access-authenticated request without a bearer credential still receives `401`.
- The credential determines exactly what you may do. Signing in grants nothing by itself;
  authorisation is enforced per operation.
