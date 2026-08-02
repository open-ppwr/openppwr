import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AUTHORIZATION_MATRIX } from '../src/permissions.mjs';

test('mutation routes declare the required authorization capability', async () => {
  const source=await readFile(new URL('../src/app.mjs',import.meta.url),'utf8');
  for(const permission of ['packaging:write','evidence:upload','evidence:review','scan:requeue','assessment:run','gap:manage','review:freeze','dossier:generate','dossier:download','audit:verify']) assert.match(source,new RegExp(`requirePermission\\(request\\.identity,\\s*['"]${permission.replace(':','\\:')}['"]`));
});

test('authorization contract contains every documented identity', () => {
  assert.deepEqual(Object.keys(AUTHORIZATION_MATRIX),['tenant_admin','compliance_manager','packaging_editor','evidence_contributor','evidence_reviewer','read_only_auditor','supplier_user','service_account','worker']);
});
