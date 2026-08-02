# ClamAV runtime validation

Status: **adapter/runtime protocol PASS; full clean-install worker deployment still open**.

## Task contract

- Scope and boundaries: production `ClamAvScanner` INSTREAM adapter against an isolated official ClamAV container; synthetic content only; no application tenant, customer data or public service.
- Acceptance: real clamd identifies synthetic clean bytes as clean and the standard antivirus test signature as infected; content is not logged; unavailable/timeout/malformed/oversized paths fail closed in automated tests.
- Forbidden changes: no customer files, no public scanner port, no persistent test container, no fake production scanner and no publication.
- Tests and negative tests: clean/infected real clamd; unit timeout, unavailable, malformed/oversized response, oversized input, integrity mismatch and storage confinement.
- Exact validation: start trusted clamd privately, then run `npm run release:clamav:validate`; run worker unit/integration suites for negative and durable-job checks.
- Migration/deployment/rollback: no schema migration; scanner runs as separate private dependency; stop worker/clamd to roll back while jobs remain durable.
- Impact: evidence bytes remain private; worker identity is database-verified and tenant-scoped; scan outcomes/retries/requeue preserve audit history; no regulatory or i18n change.

## Executed evidence — 2026-07-28

- Official image feature tag: `clamav/clamav:1.4`, pinned for execution to `sha256:6b7c8e09559250f25b0184516b0a2ae805136e57485260e16c780c9fd6e6aba9`.
- Runtime: ClamAV `1.4.5`, signatures `28073`, dated 2026-07-26.
- Network: WSL Docker port 3310 published only to host loopback during validation.
- Command: `npm run release:clamav:validate`.
- Result: `CLAMAV_RUNTIME_PASS`; clean = clean, standard test signature = infected, content logged = false; exit 0 in `0.9s`.
- Cleanup: exact ephemeral container stopped and auto-removed. Pulled image remains only in local Docker cache.

Official ClamAV documentation recommends feature-release tags for Docker deployments. Production must pin the independently reviewed digest, keep clamd private, update/monitor signatures and validate health before processing evidence.
