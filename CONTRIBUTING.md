# Contributing to OpenPPWR

Public contributions open only after OpenPPWR Community publication and
repository controls are enabled. Until then, use the private development
workflow approved by Attentus.

## Contribution rules

1. Use synthetic data only. Never submit customer, production, credential,
   upload, dump, private-infrastructure or pseudonymized real-world data.
2. Keep Community work within the boundary documented in
   `docs/architecture/OPEN_CORE_BOUNDARY.md`.
3. Do not claim guaranteed, certified or legally assured compliance.
4. Start P0 security or regulatory work with a failing reproduction test where
   practical. P0 work requires human review and cannot be self-approved by its
   author.
5. Document scope, acceptance criteria, forbidden shortcuts, tests and negative
   tests, exact validation commands, migration/deployment/rollback effects, and
   security/privacy/tenant/audit/regulatory/i18n impact.
6. Preserve real database transactions, FORCE RLS tenant isolation, verified
   authentication identity and actor/tenant audit history on release paths.
7. Obtain required CODEOWNER review for security, regulatory, architecture and
   licensing changes.
8. Certify every commit under [DCO 1.1](DCO.md) with a `Signed-off-by` trailer.

## Validation

From a clean checkout with supported Node.js and PostgreSQL environments:

```powershell
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm run test:integration
npm run test:e2e
npm run i18n:gate
npm run secret:scan
npm run gate:sast
npm run build
npm run full-gate
```

Run customer/sensitive scanning before each source, fixture, documentation or
artifact commit. Report vulnerabilities through [SECURITY.md](SECURITY.md), not
public issues.

## Licensing

Attentus-owned Community source, public SDKs/contracts, documentation, examples
and synthetic ACME assets are offered under Apache License 2.0. Do not copy code,
content or assets unless their origin and compatible license are documented.
Contributions intentionally submitted for inclusion are accepted under the
project license, consistent with Apache-2.0 section 5 and the DCO certification.

Apache-2.0 does not grant trademark rights. See [TRADEMARKS.md](TRADEMARKS.md).
