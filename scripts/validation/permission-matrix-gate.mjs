// SPDX-License-Identifier: Apache-2.0
//
// Role-matrix parity gate.
//
// The product describes what each role may do. Until now that description was prose, maintained by
// hand, in a different file from the code that enforces it — so it could be wrong indefinitely and
// nothing would say so. The owner asked for a matrix that cannot drift; this is the half of that
// promise a build can keep.
//
// It fails when:
//   - the server grants a permission the matrix does not place and label, or
//   - the matrix places a permission the server does not grant, or
//   - a role the matrix displays does not exist in the registry, or
//   - a label is missing in any supported locale.
//
//   node scripts/validation/permission-matrix-gate.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AUTHORIZATION_MATRIX, PERMISSION_CATALOGUE, permissionsFor } from '../../apps/api/src/permissions.mjs';
import { CAPABILITY_GROUPS, DISPLAY_ROLES, PLACED_PERMISSIONS } from '../../apps/web/src/permission-matrix.js';

const LOCALES = ['en', 'pl', 'de'];
const findings = [];

// Every permission the server can grant.
//
// This used to be the union of the role lists, and while `tenant_admin` was stored as `['*']` that union
// was blind to any permission held only through the wildcard — which is how `scan:requeue` lived on two
// routes, in no capability group and in no documentation, without this gate objecting. The
// registry now declares every permission explicitly, so the catalogue is the authority and the union is
// checked against it.
const registryPermissions = new Set(Object.keys(PERMISSION_CATALOGUE));
const grantedSomewhere = new Set(Object.values(AUTHORIZATION_MATRIX).flat());
const placed = new Set(PLACED_PERMISSIONS);

for (const permission of grantedSomewhere) {
  if (!registryPermissions.has(permission)) findings.push(`role lists grant "${permission}", which the catalogue does not define`);
}
if (registryPermissions.has('*')) findings.push('the catalogue defines a wildcard permission');

for (const permission of registryPermissions) {
  if (!placed.has(permission)) {
    findings.push(`the server grants "${permission}" but the matrix does not place it in any capability group`);
  }
}
for (const permission of placed) {
  if (!registryPermissions.has(permission)) {
    findings.push(`the matrix places "${permission}", which the catalogue does not define`);
  } else if (!grantedSomewhere.has(permission) && !PERMISSION_CATALOGUE[permission].unassigned) {
    findings.push(`the matrix places "${permission}" but no role holds it and no "unassigned" reason is given`);
  }
}

const duplicates = PLACED_PERMISSIONS.filter((entry, index) => PLACED_PERMISSIONS.indexOf(entry) !== index);
for (const permission of new Set(duplicates)) findings.push(`"${permission}" appears in more than one capability group`);

for (const role of DISPLAY_ROLES) {
  if (!(role in AUTHORIZATION_MATRIX)) findings.push(`the matrix displays role "${role}", which the registry does not define`);
  if (permissionsFor(role).length === 0) findings.push(`role "${role}" resolves to no permissions at all`);
}

// A role the registry defines but the matrix omits is a decision, not an accident — but it has to be
// a deliberate one, so the omission is named here rather than left to be noticed.
const DELIBERATELY_HIDDEN = new Set(['worker']);
for (const role of Object.keys(AUTHORIZATION_MATRIX)) {
  if (!DISPLAY_ROLES.includes(role) && !DELIBERATELY_HIDDEN.has(role)) {
    findings.push(`the registry defines role "${role}" and the matrix neither displays nor deliberately hides it`);
  }
}

// Labels. An unlabelled permission renders as its raw identifier, which is how a matrix stops being
// readable without ever failing.
const source = await readFile(fileURLToPath(new URL('../../apps/web/src/RoleMatrix.jsx', import.meta.url)), 'utf8');
for (const locale of LOCALES) {
  for (const permission of placed) {
    // Object keys are written bare when they are valid identifiers and quoted when they are not.
    const quoted = `'${permission}':`;
    const bare = `${permission}:`;
    if (!source.includes(quoted) && !source.includes(bare)) {
      findings.push(`permission "${permission}" has no label`);
      break;
    }
  }
  for (const group of CAPABILITY_GROUPS) {
    if (!source.includes(`${group.key}:`)) findings.push(`capability group "${group.key}" has no label`);
  }
  break; // The label table is one object per locale; a missing key in any of them fails the check above.
}

// 5. The Markdown matrix, cell by cell against the registry.
//
// `docs/security/AUTHORIZATION_MATRIX.md` states that this gate and the permission tests "assert the
// machine-readable form of the same claims". They did not: this gate read `RoleMatrix.jsx`, the test read
// `permission-matrix.js`, and nothing read the Markdown — so a wrong cell in the document a human reader
// actually consults would have passed both indefinitely. The claim was made in the same file that
// had two wrong cells until the wildcard was removed.
//
// Cell vocabulary: `A` the role holds the permission; `S` or `Own` it holds the -own variant; `-` it holds
// neither.
const documentPath = fileURLToPath(new URL('../../docs/security/AUTHORIZATION_MATRIX.md', import.meta.url));
const document = await readFile(documentPath, 'utf8');

const CAPABILITY_PERMISSIONS = {
  'View tenant records': { full: 'read', own: 'read-own' },
  'Packaging import/write': { full: 'packaging:write' },
  'Evidence upload': { full: 'evidence:upload', own: 'evidence:upload' },
  'Evidence review': { full: 'evidence:review' },
  'Evidence download': { full: 'evidence:download', own: 'evidence:download-own' },
  'Run assessment': { full: 'assessment:run' },
  'Manage gaps/remediation': { full: 'gap:manage' },
  'Freeze review snapshot': { full: 'review:freeze' },
  'Generate dossier': { full: 'dossier:generate' },
  'Download dossier': { full: 'dossier:download' },
  'Verify audit': { full: 'audit:verify' },
  'Requeue a terminal scan job': { full: 'scan:requeue' },
  "Rotate another identity's credential": { full: 'credential:rotate' },
  'Process scan job': { full: 'scan:process' },
};
const COLUMN_ROLES = {
  'Tenant admin': 'tenant_admin',
  'Compliance manager': 'compliance_manager',
  'Packaging editor': 'packaging_editor',
  'Evidence contributor': 'evidence_contributor',
  'Evidence reviewer': 'evidence_reviewer',
  'Read-only auditor': 'read_only_auditor',
  'Supplier user': 'supplier_user',
  'Service account': 'service_account',
  Worker: 'worker',
};

const tableRows = document.split(/\r?\n/u).filter((line) => line.startsWith('| ') && !line.startsWith('|---'));
const header = tableRows.shift();
if (!header) findings.push('the authorization matrix document has no table');
else {
  const columns = header.split('|').slice(2, -1).map((cell) => cell.trim());
  const unknownColumns = columns.filter((column) => !(column in COLUMN_ROLES));
  for (const column of unknownColumns) findings.push(`the matrix document has a column "${column}" this gate cannot map to a role`);

  // A column silently dropped from the header (say, "Worker") is not an unknown column — it is an
  // absent one, and the loop below only ever inspects columns that are present. Without this check,
  // deleting a role's column entirely removes every claim that role's cells ever made, and the gate
  // has nothing left to disagree with.
  const missingColumns = Object.keys(COLUMN_ROLES).filter((column) => !columns.includes(column));
  for (const column of missingColumns) findings.push(`the matrix document is missing the "${column}" column entirely`);

  const documented = new Set();
  for (const row of tableRows) {
    const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
    const capability = cells.shift();
    const mapping = CAPABILITY_PERMISSIONS[capability];
    if (!mapping) {
      findings.push(`the matrix document has a capability row "${capability}" this gate cannot map to a permission`);
      continue;
    }
    documented.add(capability);
    // A row with fewer or more cells than the header has columns would otherwise map by position
    // silently — a trailing cell falls off the end (skipped by the `!role` guard) and a missing one
    // shifts every later column's claim onto the wrong role. Neither raises a finding on its own.
    if (cells.length !== columns.length) {
      findings.push(`${capability}: row has ${cells.length} cell(s) but the header declares ${columns.length} column(s)`);
      continue;
    }
    for (const [index, cell] of cells.entries()) {
      const role = COLUMN_ROLES[columns[index]];
      if (!role) continue;
      const granted = new Set(permissionsFor(role));
      const claimsFull = cell === 'A';
      const claimsOwn = cell === 'S' || cell === 'Own';
      if (!claimsFull && !claimsOwn && cell !== '-') {
        findings.push(`${capability} / ${columns[index]}: "${cell}" is not one of A, S, Own or -`);
        continue;
      }
      const expected = claimsFull ? mapping.full : claimsOwn ? mapping.own : null;
      if (claimsOwn && !mapping.own) {
        findings.push(`${capability} / ${columns[index]}: the document claims a scoped grant and this capability has no -own variant`);
        continue;
      }
      if (expected && !granted.has(expected)) {
        findings.push(`${capability} / ${columns[index]}: the document says "${cell}" but ${role} does not hold ${expected}`);
      }
      if (!expected) {
        for (const permission of [mapping.full, mapping.own].filter(Boolean)) {
          if (granted.has(permission)) findings.push(`${capability} / ${columns[index]}: the document says "-" but ${role} holds ${permission}`);
        }
      }
    }
  }

  // And every catalogued permission must appear in the document, or a capability can be granted and
  // undocumented — which is exactly how `scan:requeue` reached two routes with no row of its own.
  const documentedPermissions = new Set(
    [...documented].flatMap((capability) => [CAPABILITY_PERMISSIONS[capability].full, CAPABILITY_PERMISSIONS[capability].own].filter(Boolean)),
  );
  for (const permission of Object.keys(PERMISSION_CATALOGUE)) {
    if (!documentedPermissions.has(permission)) findings.push(`the catalogue defines "${permission}" and the matrix document has no row for it`);
  }
}

if (findings.length) {
  console.error(`PERMISSION_MATRIX_FAIL findings=${findings.length}`);
  for (const finding of [...new Set(findings)]) console.error(`  ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`PERMISSION_MATRIX_PASS roles=${DISPLAY_ROLES.length} permissions=${placed.size} document_rows=${tableRows.length} document_cells=${tableRows.length * Object.keys(COLUMN_ROLES).length}`);
}
