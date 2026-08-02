// SPDX-License-Identifier: Apache-2.0
//
// Route validation property gate.
//
// The property, stated once:
//
//   No untrusted identifier reaches a database query, filesystem lookup, artifact lookup or business
//   service before successful type and format validation.
//
// This exists because the same defect was fixed three times in one session. Each fix was correct for
// the routes it touched and each test was written to match the fix rather than the property, so the
// next route repeated it. A gate that checks the property cannot be satisfied by patching instances.
//
//   node scripts/validation/route-validation-gate.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = await readFile(fileURLToPath(new URL('../../apps/api/src/app.mjs', import.meta.url)), 'utf8');
const lines = source.split('\n');
const findings = [];

// The identifier inventory. Every external identifier, its column type, and the validator that applies
// to that type. A `text` key must not be checked as a UUID — that rejects legitimate values, and it
// happened — but "not a UUID" was recorded here as `validator: null`, which exempted three routes from
// the very property this gate exists to assert. A
// textual identifier with a defined format has a validator of its own: `requireGapId`.
const INVENTORY = [
  { route: '/v1/dossiers/:id/download', param: 'id', table: 'dossier_artifacts', type: 'uuid', validator: 'requireUuid' },
  { route: '/v1/review-snapshots/:id/dossier', param: 'id', table: 'review_snapshots', type: 'uuid', validator: 'requireUuid' },
  { route: '/v1/evidence/:id/review', param: 'id', table: 'evidence_files', type: 'uuid', validator: 'requireUuid' },
  { route: '/v1/evidence/:id/download', param: 'id', table: 'evidence_files', type: 'uuid', validator: 'requireUuid' },
  { route: '/v1/scan-jobs/:id/requeue', param: 'id', table: 'scan_jobs', type: 'uuid', validator: 'requireUuid' },
  { route: '/v1/identities/:id/rotate-credential', param: 'id', table: 'identities', type: 'uuid', validator: 'requireUuid' },
  { route: '/v1/gaps/:id/assign', param: 'id', table: 'gaps', type: 'text-format', validator: 'requireGapId' },
  { route: '/v1/gaps/:id/remediate', param: 'id', table: 'gaps', type: 'text-format', validator: 'requireGapId' },
  { route: '/v1/gaps/:id/reassess', param: 'id', table: 'gaps', type: 'text-format', validator: 'requireGapId' },
  { route: '/v1/catalog/:resource', param: 'resource', table: null, type: 'enum', validator: 'allowlist' },
];

const routes = [];
for (const [index, line] of lines.entries()) {
  const match = /app\.(get|post|put|patch|delete)\('([^']+)'/u.exec(line);
  if (match) routes.push({ line: index, path: match[2], method: match[1].toUpperCase() });
}

const bodyOf = (index) => {
  const position = routes.findIndex((route) => route.line === routes[index].line);
  const end = routes[position + 1]?.line ?? lines.length;
  return lines.slice(routes[position].line, end);
};

// 1. The inventory describes reality: no route with a parameter is missing from it, and no entry
// describes a route that no longer exists.
const parameterised = routes.filter((route) => route.path.includes(':'));
for (const route of parameterised) {
  if (!INVENTORY.some((entry) => entry.route === route.path)) {
    findings.push(`${route.path} takes a parameter and is not in the identifier inventory`);
  }
}
for (const entry of INVENTORY) {
  if (!routes.some((route) => route.path === entry.route)) {
    findings.push(`the inventory describes ${entry.route}, which no longer exists`);
  }
}

// 2. Every uuid-keyed route validates, and validates before anything uses the raw value.
for (const [index, route] of routes.entries()) {
  const entry = INVENTORY.find((candidate) => candidate.route === route.path);
  if (!entry) continue;
  const body = bodyOf(index);
  const joined = body.join('\n');

  if (entry.type === 'uuid' || entry.type === 'text-format') {
    if (!joined.includes(entry.validator)) {
      findings.push(`${route.path}: ${entry.type} key with no ${entry.validator}`);
      continue;
    }
    // Position matters. A validator called below a query that already received the raw value is not
    // a validator; that exact shape shipped and returned 500 on a malformed identifier.
    for (const [offset, line] of body.entries()) {
      if (line.trimStart().startsWith('//')) continue;
      for (const match of line.matchAll(/request\.params\.\w+/gu)) {
        const preceding = line.slice(Math.max(0, match.index - 14), match.index);
        if (!preceding.includes(`${entry.validator}(`)) {
          findings.push(`${route.path}: raw ${match[0]} used at line ${routes[index].line + offset + 1} without ${entry.validator}`);
        }
      }
    }
  }

  // A textual key must not be checked as a UUID: it rejects every legitimate identifier.
  if (entry.type === 'text-format' && joined.includes('requireUuid(')) {
    findings.push(`${route.path}: ${entry.table}.${entry.param} is text; requiring a UUID rejects legitimate identifiers`);
  }
  // And `validator: null` is no longer a way to opt a route out of the property.
  if (entry.type !== 'enum' && !entry.validator) {
    findings.push(`${route.path}: ${entry.table}.${entry.param} has no validator; every identifier type needs one`);
  }

  if (entry.type === 'enum') {
    // A keyed lookup is an allowlist, and a stronger one than a membership test: the parameter selects
    // a literal the codebase wrote, so an unknown key cannot produce a query at all. What must be
    // present is the refusal for the miss — without it the lookup yields undefined and the failure
    // happens somewhere less predictable.
    const reference = `request.params.${entry.param}`;
    const keyedLookup = joined.includes(`[${reference}]`);
    const membership = /allowlist|Object\.keys|\.includes\(/u.test(joined);
    if (!keyedLookup && !membership) findings.push(`${route.path}: enum parameter with no visible allowlist`);
    if (keyedLookup && !joined.includes('RESOURCE_NOT_FOUND')) {
      findings.push(`${route.path}: keyed lookup with no refusal for an unknown key`);
    }
    // The selected value must be a literal this codebase wrote, never assembled from the parameter.
    // Interpolating or concatenating the parameter into SQL is the one shape a keyed lookup rules out,
    // so it is worth asserting rather than assuming.
    if (joined.includes(`\${${reference}}`) || joined.includes(`+ ${reference}`) || joined.includes(`+${reference}`)) {
      findings.push(`${route.path}: the parameter is built into SQL rather than selecting a literal`);
    }
  }
}

// 3. The refusal is uniform. A validator that raises anything other than the ordinary not-found
// reintroduces the oracle it was added to remove.
for (const name of ['requireUuid', 'requireGapId']) {
  const validator = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`, 'u').exec(source)?.[0] || '';
  if (!validator) {
    findings.push(`${name} is not defined in app.mjs`);
    continue;
  }
  if (!validator.includes('RESOURCE_NOT_FOUND')) findings.push(`${name} does not raise RESOURCE_NOT_FOUND`);
  if (!validator.includes('status: 404')) findings.push(`${name} does not refuse with 404`);
}

// The gap identifier pattern is anchored, bounded and case-exact. Unanchored, it would accept a
// traversal segment or a control character carrying a valid prefix; unbounded, an arbitrarily long
// value would reach the query; case-insensitive, every gap would have more than one spelling.
const gapPattern = /const GAP_ID = (\/.*\/[a-z]*);/u.exec(source)?.[1] || '';
if (!gapPattern) findings.push('the gap identifier pattern was not found');
else {
  if (!gapPattern.startsWith('/^') || !/\$\/[a-z]*$/u.test(gapPattern)) findings.push('the gap identifier pattern is not anchored at both ends');
  if (/\{\d+,\}|\+|\*/u.test(gapPattern)) findings.push('the gap identifier pattern has no upper length bound');
  if (/\/[a-z]*i[a-z]*$/u.test(gapPattern)) findings.push('the gap identifier pattern is case-insensitive, which gives every gap more than one spelling');
}

// 4. The error handler never echoes a code this codebase did not raise, and never suppresses one it
// did. Both directions failed once: a PostgreSQL SQLSTATE reached a caller, and then the fix
// flattened a deliberate 500 the caller is meant to see.
const handler = /app\.use\(\(error, request, response, _next\)[\s\S]*?\n  \}\);/u.exec(source)?.[0] || '';
if (!handler) findings.push('the global error handler was not found');
else {
  if (!handler.includes('Number.isInteger(Number(error.status))')) {
    findings.push('the error handler does not use an explicit status to decide whether a code is deliberate');
  }
  if (!/INTERNAL_ERROR/u.test(handler)) findings.push('the error handler has no fallback code');
  if (/status < 500 &&/u.test(handler)) {
    findings.push('the error handler keys on the status band, which flattens deliberate 500s such as EVIDENCE_INTEGRITY_MISMATCH');
  }
}

if (findings.length) {
  console.error(`ROUTE_VALIDATION_PROPERTY_FAIL findings=${findings.length}`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exitCode = 1;
} else {
  const uuidRoutes = INVENTORY.filter((entry) => entry.type === 'uuid').length;
  console.log(`ROUTE_VALIDATION_PROPERTY_PASS routes=${routes.length} parameterised=${parameterised.length} uuid_keyed=${uuidRoutes}`);
}
