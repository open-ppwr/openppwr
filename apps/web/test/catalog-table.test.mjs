// The catalog table rendered English column headings and raw database enum values inside otherwise
// translated Polish and German screens. Measured against the real functions the table calls, the header
// row for the packaging resource was:
//
//   pl -> id | name | packaging type | country | ID dostawcy | Status
//   de -> id | name | packaging type | country | Lieferanten-ID | Status
//
// — two of six cells translated, four of them the raw column name with its underscores removed, which is
// what `columnLabel` falls back to when no `col_*` label exists. `packaging_type` was worse: a closed
// CHECK enum in the schema whose five stored values ('sales','grouped','transport','ecommerce','reusable')
// were printed to the screen in English in every locale, because the column was absent from the set of
// columns the table renders as translated badges.
//
// The column set is read out of App.jsx rather than restated here, so a column added to the catalog in
// future is covered by this file the moment it is added — which is the property the i18n gate lacked, and
// the reason eight columns shipped with no label at all.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { catalogs, columnLabel, enumLabel, SUPPORTED_LOCALES } from '../src/i18n.js';

const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const schema = await readFile(new URL('../../../packages/database/migrations/001_phase4_foundation.sql', import.meta.url), 'utf8');
const quoted = (text) => [...text.matchAll(/'([^']+)'/gu)].map((match) => match[1]);

function declaration(name) {
  const start = source.search(new RegExp(`\\bconst\\s+${name}\\s*=`, 'u'));
  assert.ok(start >= 0, `${name} must be declared in App.jsx`);
  let depth = 0;
  for (let index = source.indexOf('=', start); index < source.length; index += 1) {
    const character = source[index];
    if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') { depth -= 1; if (depth === 0) return source.slice(start, index + 1); }
  }
  throw new Error(`${name} declaration is unterminated`);
}

// { packaging: ['id','name',…], … } — the resource-to-column map the table is driven by.
const catalogColumns = Object.fromEntries(
  [...declaration('catalogColumns').matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/gu)].map((match) => [match[1], quoted(match[2])]),
);
const enumColumns = new Set(quoted(/enumColumns\s*=\s*new Set\(\[([^\]]*)\]\)/u.exec(source)[1]));
const catalogColumnNames = [...new Set(Object.values(catalogColumns).flat())];

// Closed CHECK enums, by column, straight from the migration — the authority on which value sets exist.
const schemaEnums = new Map();
for (const match of schema.matchAll(/(?:^|[\s(,])(\w+)\s+text\b[^,]*?CHECK\s*\(\s*\1\s+IN\s*\(([^)]*)\)/gimu)) {
  const column = match[1].toLowerCase();
  if (!schemaEnums.has(column)) schemaEnums.set(column, new Set());
  for (const value of quoted(match[2])) schemaEnums.get(column).add(value.toLowerCase());
}

test('the source the catalog table is driven by was read, not silently missed', () => {
  assert.deepEqual(Object.keys(catalogColumns).sort(), ['boms', 'components', 'materials', 'packaging', 'suppliers']);
  assert.equal(catalogColumnNames.length, 12, 'twelve distinct columns are rendered across the five resources');
  assert.deepEqual([...schemaEnums.get('packaging_type')].sort(), ['ecommerce', 'grouped', 'reusable', 'sales', 'transport']);
});

test('every column the catalog renders has a heading in every locale', () => {
  const missing = [];
  for (const locale of SUPPORTED_LOCALES) {
    for (const column of catalogColumnNames) {
      const label = catalogs[locale][`col_${column}`];
      if (typeof label !== 'string' || !label.trim()) missing.push(`${locale}:${column}`);
    }
  }
  assert.deepEqual(missing, [], 'a column with no col_* label is rendered as its raw database name');
});

test('no catalog heading falls back to the raw database column name', () => {
  // `columnLabel` returns `column.replaceAll('_',' ')` when no label exists. That fallback is what put
  // "packaging type", "recycled content pct", "mass g" and "material id" into a Polish and a German table.
  const raw = [];
  for (const locale of SUPPORTED_LOCALES) {
    for (const column of catalogColumnNames) {
      if (columnLabel(locale, column) === column.replaceAll('_', ' ')) raw.push(`${locale}:${column}`);
    }
  }
  assert.deepEqual(raw, []);
});

test('the packaging header row is fully translated in all three languages', () => {
  const header = (locale) => catalogColumns.packaging.map((column) => columnLabel(locale, column));
  assert.deepEqual(header('en'), ['ID', 'Name', 'Packaging type', 'Country', 'Supplier ID', 'Status']);
  assert.deepEqual(header('pl'), ['Identyfikator', 'Nazwa', 'Rodzaj opakowania', 'Kraj', 'ID dostawcy', 'Status']);
  assert.deepEqual(header('de'), ['Kennung', 'Bezeichnung', 'Verpackungsart', 'Land', 'Lieferanten-ID', 'Status']);
});

test('the materials and components header rows are fully translated too', () => {
  const header = (resource, locale) => catalogColumns[resource].map((column) => columnLabel(locale, column));
  assert.deepEqual(header('materials', 'pl'), ['Identyfikator', 'Nazwa', 'Grupa materiałowa', 'Zawartość materiału z recyklingu (%)']);
  assert.deepEqual(header('components', 'de'), ['Kennung', 'Bezeichnung', 'Material', 'Lieferanten-ID', 'Masse (g)']);
});

test('a catalog column whose values the schema closes is rendered as a translated enum', () => {
  // The check that would have caught `packaging_type`: the schema decides which columns hold a closed set,
  // and every one of those the catalog shows must be in `enumColumns` or its values print in English.
  const untranslated = catalogColumnNames.filter((column) => schemaEnums.has(column) && !enumColumns.has(column));
  assert.deepEqual(untranslated, []);
  assert.ok(enumColumns.has('packaging_type'));
  // `family` must stay out: the schema places no CHECK on it, so its values are the operator's own material
  // identifiers and translating them would break the match against the imported source data.
  assert.equal(schemaEnums.has('family'), false);
  assert.equal(enumColumns.has('family'), false);
});

test('every packaging type the schema permits is translated in every locale', () => {
  for (const value of schemaEnums.get('packaging_type')) {
    for (const locale of SUPPORTED_LOCALES) {
      const label = enumLabel(locale, value);
      assert.notEqual(label, value, `${locale} renders the stored value "${value}" unchanged`);
      assert.ok(label.trim().length > 0);
    }
    // A Polish or German label identical to the English one is an untranslated fallback, which is the
    // defect rather than a translation of it.
    assert.notEqual(enumLabel('pl', value), enumLabel('en', value), value);
    assert.notEqual(enumLabel('de', value), enumLabel('en', value), value);
  }
  assert.equal(enumLabel('pl', 'sales'), 'Opakowanie jednostkowe');
  assert.equal(enumLabel('de', 'grouped'), 'Umverpackung');
  assert.equal(enumLabel('en', 'transport'), 'Transport packaging');
});
