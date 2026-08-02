import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectEvidenceMime, normalizeEvidenceFilename } from '../src/evidence-service.mjs';

test('filename normalization rejects traversal and double extensions', () => {
  for (const name of ['../evidence.pdf','folder/evidence.pdf','folder\\evidence.pdf','evidence.exe','evidence.txt.pdf','']) {
    assert.throws(() => normalizeEvidenceFilename(name));
  }
  assert.deepEqual(normalizeEvidenceFilename('synthetic declaration.pdf'), { normalized:'synthetic declaration.pdf',extension:'.pdf',expectedMime:'application/pdf' });
});

test('content detection uses signatures and fails binary ambiguity', () => {
  assert.equal(detectEvidenceMime(Buffer.from('%PDF-1.4\n')),'application/pdf');
  assert.equal(detectEvidenceMime(Buffer.from([0,1,2,3])),'application/octet-stream');
  assert.equal(detectEvidenceMime(Buffer.from('synthetic,csv\n')),'text/plain');
});


// ---------------------------------------------------------------------------------------------------
// Active content inside a permitted type.
//
// Every case below passes the checks the product already had: the declared type, the extension and the
// leading signature all agree, and ClamAV correctly calls them clean, because none of them is malware. They
// are documents that do something when opened.
// ---------------------------------------------------------------------------------------------------

test('a PDF carrying an action or an embedded file is refused', async () => {
  const { findActiveContent } = await import('../src/evidence-service.mjs');
  for (const marker of ['/JavaScript', '/OpenAction', '/Launch', '/EmbeddedFile', '/RichMedia', '/SubmitForm', '/ImportData']) {
    const pdf = Buffer.from(`%PDF-1.4\n1 0 obj\n<< ${marker} 2 0 R >>\nendobj\ntrailer\n%%EOF\n`);
    const verdict = findActiveContent(pdf, 'application/pdf');
    assert.equal(verdict?.kind, 'pdf_action', `${marker} was not detected`);
    assert.equal(verdict.marker, marker);
  }
});

// The action can sit anywhere, and the typing check only ever read the first 4 KB — which is the right amount
// to identify a format and the wrong amount to find this.
test('an action beyond the first 4 KB is still found', async () => {
  const { findActiveContent } = await import('../src/evidence-service.mjs');
  const padded = Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.from('% padding\n'.repeat(2000)),
    Buffer.from('<< /OpenAction 2 0 R >>\ntrailer\n%%EOF\n'),
  ]);
  assert.ok(padded.length > 4096);
  assert.equal(findActiveContent(padded, 'application/pdf')?.marker, '/OpenAction');
});

test('an ordinary PDF is not refused', async () => {
  const { findActiveContent } = await import('../src/evidence-service.mjs');
  for (const pdf of [
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n%%EOF\n',
    '%PDF-1.7\n<< /Type /Page /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >> >>\n%%EOF\n',
    '%PDF-1.4\nstream\nBT /F1 12 Tf (Recycled content declaration) Tj ET\nendstream\n%%EOF\n',
  ]) {
    assert.equal(findActiveContent(Buffer.from(pdf), 'application/pdf'), null, `refused a legitimate PDF: ${pdf.slice(0, 40)}`);
  }
  // Lower case is not a PDF name object, so it must not trip the check either.
  assert.equal(findActiveContent(Buffer.from('%PDF-1.4\n% /javascript is not a name object\n'), 'application/pdf'), null);
});

test('a CSV cell that is a formula is refused', async () => {
  const { findActiveContent } = await import('../src/evidence-service.mjs');
  for (const csv of ['=1+1', '@SUM(A1)', '-1+1', '+cmd|/c calc', 'id,value\n1,=HYPERLINK("http://x","y")', ' =2']) {
    assert.equal(findActiveContent(Buffer.from(csv), 'text/csv')?.kind, 'csv_formula', `not detected: ${JSON.stringify(csv)}`);
  }
});

// The comma was the only delimiter the parser recognised, and the whole defence hangs off cell boundaries:
// `safe;=2+2` parsed as one cell whose text merely contains an equals sign, so nothing fired. That is the
// wrong way round for a product shipping in Polish, German and English — Excel uses the operating system's
// list separator, which is `;` across most of the EU, and a `sep=;` first line makes it use `;` regardless
// of locale. The reviewer downloads evidence as an attachment and opens it in their own spreadsheet, where
// the headers that contain an embedded payload no longer help at all.
test('a formula is refused whichever delimiter the spreadsheet used', async () => {
  const { findActiveContent } = await import('../src/evidence-service.mjs');
  const byDelimiter = [
    ['semicolon with an Excel separator hint', 'sep=;\nheader;value\nsafe;=2+2'],
    ['semicolon', 'header;value\nsafe;=2+2'],
    ['tab', 'header\tvalue\nsafe\t=2+2'],
    ['pipe', 'header|value\nsafe|=2+2'],
    ['semicolon with a leading minus', 'header;value\nsafe;-2+2'],
    ['semicolon with a leading at-sign', 'header;value\nsafe;@SUM(A1)'],
  ];
  for (const [label, csv] of byDelimiter) {
    assert.equal(
      findActiveContent(Buffer.from(csv), 'text/csv')?.kind,
      'csv_formula',
      `not detected with ${label}: ${JSON.stringify(csv)}`,
    );
  }
});

// And the half that matters for not breaking real uploads: a semicolon in ordinary prose is not a
// delimiter problem, and a company name is not a formula.
test('widening the delimiter set does not refuse ordinary evidence', async () => {
  const { findActiveContent } = await import('../src/evidence-service.mjs');
  for (const csv of [
    'name;country\nACME GmbH;Deutschland',
    'note\nDelivered on time; no issues found',
    'supplier\tmaterial\nACME\tPET',
    'id,name\nACME-SUP-001,ACME Verpackungen',
  ]) {
    assert.equal(findActiveContent(Buffer.from(csv), 'text/csv'), null, `false positive: ${JSON.stringify(csv)}`);
  }
});

// The half of this rule that matters for not breaking real data: a compliance dataset legitimately contains
// negative numbers, and a control that refuses `-5` is not a safer control.
test('a CSV containing ordinary signed numbers is not refused', async () => {
  const { findActiveContent } = await import('../src/evidence-service.mjs');
  for (const csv of ['-5', '+3.14', 'id,delta\nACME-PKG-0001,-12', 'a,b,c\n1,-5,3', 'value\n-0,5', '1000,-2500.75']) {
    assert.equal(findActiveContent(Buffer.from(csv), 'text/csv'), null, `refused legitimate data: ${JSON.stringify(csv)}`);
  }
});

test('types with no active-content notion are not inspected', async () => {
  const { findActiveContent } = await import('../src/evidence-service.mjs');
  for (const mime of ['image/png', 'image/jpeg', 'text/plain']) {
    assert.equal(findActiveContent(Buffer.from('=1+1 /OpenAction /JavaScript'), mime), null, `${mime} must not be inspected for active content`);
  }
});

// The limitation, asserted so it cannot be quietly forgotten. Two short markers and a hex-encoded-name
// heuristic were removed because they would refuse ordinary compressed supplier documents, so this control is
// evadable by design, and active-content handling stays partially mitigated rather than closed.
test('the check is honestly incomplete and says so', async () => {
  const { findActiveContent } = await import('../src/evidence-service.mjs');
  const { readFile } = await import('node:fs/promises');
  // A hex-encoded name is a real evasion and is deliberately not detected.
  assert.equal(findActiveContent(Buffer.from('%PDF-1.4\n<< /J#61vaScript 2 0 R >>'), 'application/pdf'), null);
  const source = await readFile(new URL('../src/evidence-service.mjs', import.meta.url), 'utf8');
  assert.match(source, /partially mitigated/u, 'the source must record that this control is incomplete');
  assert.ok(!source.includes("'/JS'"), 'the short marker was removed on purpose and must stay removed');
});
