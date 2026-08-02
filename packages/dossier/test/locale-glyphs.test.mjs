// The architecture document says this package embeds a Unicode font and that localized EN/PL/DE output is
// verified. Nothing verified it.
//
// The sibling suite drives the generator with `ACME Łódź — Żółć` and `ACME Köln — Größe`, but it only asserts
// that two runs are byte-identical and that the buffer starts with `%PDF-`. Both of those hold when every
// diacritic is dropped, replaced with a blank box or silently mapped to glyph 0: a deterministically wrong
// PDF is still deterministic. Nor does the shipped output demonstrate the capability — the German catalogue
// is `Bewertungen / Ergebnisse / Regeln / Erstellt`, which carries no umlaut, and the data reaching the page
// is an ASCII organisation name, an ISO timestamp and a rule identifier, so a German dossier as shipped
// contains no character outside ASCII at all.
//
// So this file asserts the claim where the claim is made: that a dossier generated for a locale renders that
// locale's characters. Rendering is not "the bytes were accepted" — a PDF viewer shows a glyph, so the
// evidence has to reach the glyph:
//
//   1. the page's text is decoded back through the font's own `/ToUnicode` CMap, which is what a viewer's
//      copy, search and accessibility path uses, and every character of the alphabet must come back out;
//   2. no code used on the page may be absent from that CMap, and none may resolve to glyph 0 — `.notdef`,
//      the empty or hollow-box glyph that a failed character map produces;
//   3. the glyph each character resolves to is located in the embedded subset's own `glyf` table and must
//      carry a real outline. A precomposed diacritic is normally a composite glyph that draws nothing
//      itself, so composites are followed down to the simple glyphs that do, and the total contour count
//      must be positive. This is the step that fails when subsetting keeps the character map but drops the
//      outlines, which is the one fault that would still let a viewer claim it has the character.
//
// Where the demonstration data lives is a deliberate choice: here, not in the synthetic ACME dataset.
//
// The claim is a property of the renderer, not of one sample. An exhaustive payload driven through the
// generator proves it for any input; a sample organisation name that happens to carry three diacritics
// proves it only for those three, and only until somebody renames the record. The ACME names are also
// deliberately ASCII-transliterated — `Beispielstrasse`, `ul. Przykladowa`, `Poznan` — because that dataset
// is exported as downloadable CSV and JSON, imported back through the CSV path, and hashed into a checksum
// manifest that a drift gate enforces; changing those names to carry diacritics would change what the
// dataset is for and force every consumer of the manifest to re-baseline, in order to test something the
// dataset is not the subject of. And no plausible company name contains all twenty-five characters at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDossierArtifacts } from '../src/index.mjs';

// The whole alphabet each locale needs beyond ASCII, not a sample of it: a subsetting or encoding fault that
// loses one character must not be able to hide behind the ones that survived.
const LOCALE_ALPHABET = {
  pl: 'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ',
  de: 'äöüßÄÖÜ',
};

// Proves the page examined is the localized document and not some fallback, so a generator that quietly fell
// back to the English catalogue cannot pass by rendering an organisation name correctly.
const LOCALE_TITLE = {
  pl: 'Dokumentacja OpenPPWR Community',
  de: 'OpenPPWR Community Dossier',
};

function snapshotFor(locale) {
  return {
    schemaVersion: '1.0.0',
    locale,
    generatedAt: '2026-07-28T12:00:00.000Z',
    tenantId: 'ACME-EU-DEMO',
    // The alphabet reaches the page through the field a real dossier uses for the organisation name, so it
    // travels the same canonicalisation, layout and encoding path as production data rather than a side door.
    organization: `ACME ${locale.toUpperCase()} ${LOCALE_ALPHABET[locale]}`,
    assessment: { id: 'A-1', outcome: 'PASS', ruleId: 'OPENPPWR-DEMO-001', ruleVersion: '1.0.0' },
    evidence: [],
    gaps: [],
    auditVerification: { valid: true },
  };
}

// A PDF reader that understands exactly as much as this package's own output requires and no more.
//
// It is a single forward pass rather than a scan for object headers, because a font program is binary and
// may contain any byte sequence, including one that looks like `12 0 obj`. Each stream is skipped by its
// declared `/Length`, so binary content is never parsed as structure. This package writes uncompressed
// streams (`compress: false`), which is what makes reading them without a filter implementation legitimate.
function readIndirectObjects(pdf) {
  const text = pdf.toString('latin1');
  const objects = new Map();
  let cursor = 0;
  while (cursor < text.length) {
    const marker = text.indexOf(' 0 obj', cursor);
    if (marker < 0) break;
    let digits = marker;
    while (digits > 0 && text[digits - 1] >= '0' && text[digits - 1] <= '9') digits -= 1;
    if (digits === marker) { cursor = marker + 6; continue; }
    const id = Number(text.slice(digits, marker));
    const bodyStart = marker + 6;
    const streamAt = text.indexOf('stream', bodyStart);
    const endAt = text.indexOf('endobj', bodyStart);
    if (streamAt >= 0 && (endAt < 0 || streamAt < endAt)) {
      const dict = text.slice(bodyStart, streamAt);
      let dataStart = streamAt + 'stream'.length;
      if (text[dataStart] === '\r') dataStart += 1;
      if (text[dataStart] === '\n') dataStart += 1;
      const declared = Number(/\/Length\s+(\d+)/u.exec(dict)?.[1]);
      const length = Number.isInteger(declared) ? declared : text.indexOf('endstream', dataStart) - dataStart;
      objects.set(id, { dict, data: pdf.subarray(dataStart, dataStart + length) });
      cursor = dataStart + length;
    } else {
      objects.set(id, { dict: text.slice(bodyStart, endAt < 0 ? undefined : endAt), data: null });
      cursor = (endAt < 0 ? text.length : endAt) + 6;
    }
  }
  return objects;
}

function findObject(objects, pattern) {
  for (const [id, object] of objects) if (pattern.test(object.dict)) return { id, ...object };
  return null;
}

function reference(dict, key) {
  const found = new RegExp(`/${key}\\s*\\[?\\s*(\\d+)\\s+0\\s+R`, 'u').exec(dict);
  return found ? Number(found[1]) : null;
}

function hexBytes(text) {
  const digits = text.replace(/[^0-9a-fA-F]/gu, '');
  return Buffer.from(digits.length % 2 === 0 ? digits : `${digits}0`, 'hex');
}

function fromUtf16be(buffer) {
  return Buffer.from(buffer).swap16().toString('utf16le');
}

// Parses the `/ToUnicode` CMap into code -> text. Both `bfchar` and both `bfrange` forms are handled: this
// package's writer currently emits only the array form, but a CMap that a viewer would honour must be read
// the way a viewer reads it, or the test measures the writer's habits instead of the document's meaning.
function parseToUnicode(data) {
  let text = data.toString('latin1');
  const map = new Map();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>/gu)) {
      map.set(hexBytes(pair[1]).readUInt16BE(0), fromUtf16be(hexBytes(pair[2])));
    }
  }
  // The array form is consumed first and then removed, because its destinations are consecutive hex strings
  // and the contiguous form's pattern would otherwise match three of them in a row and invent mappings.
  text = text.replace(/<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>\s*\[([^\]]*)\]/gu, (whole, low, _high, body) => {
    const first = hexBytes(low).readUInt16BE(0);
    let index = 0;
    for (const destination of body.matchAll(/<([0-9a-fA-F\s]+)>/gu)) {
      map.set(first + index, fromUtf16be(hexBytes(destination[1])));
      index += 1;
    }
    return ' '.repeat(whole.length);
  });
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/gu)) {
    for (const span of block[1].matchAll(/<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>/gu)) {
      const low = hexBytes(span[1]).readUInt16BE(0);
      const high = hexBytes(span[2]).readUInt16BE(0);
      const destination = hexBytes(span[3]);
      for (let code = low; code <= high; code += 1) {
        const shifted = Buffer.from(destination);
        shifted.writeUInt16BE(shifted.readUInt16BE(shifted.length - 2) + (code - low), shifted.length - 2);
        map.set(code, fromUtf16be(shifted));
      }
    }
  }
  return map;
}

// Reads the page back the way a viewer's text layer does: every string shown between BT and ET, decoded
// through the CMap. Under Identity-H each code is two bytes and is also the glyph index, which is asserted
// separately by requiring `/CIDToGIDMap /Identity`.
function decodePageText(content, toUnicode) {
  const text = content.toString('latin1');
  const codes = [];
  let decoded = '';
  const unmapped = [];
  for (const block of text.matchAll(/BT([\s\S]*?)ET/gu)) {
    for (const shown of block[1].matchAll(/<([0-9a-fA-F\s]*)>/gu)) {
      const bytes = hexBytes(shown[1]);
      for (let at = 0; at + 1 < bytes.length; at += 2) {
        const code = bytes.readUInt16BE(at);
        codes.push(code);
        const mapped = toUnicode.get(code);
        if (mapped === undefined) unmapped.push(code);
        else decoded += mapped;
      }
    }
  }
  return { codes, decoded, unmapped };
}

function readGlyphs(fontFile) {
  const tables = new Map();
  const count = fontFile.readUInt16BE(4);
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    tables.set(fontFile.toString('latin1', record, record + 4).trim(), {
      offset: fontFile.readUInt32BE(record + 8),
      length: fontFile.readUInt32BE(record + 12),
    });
  }
  const head = tables.get('head');
  const maxp = tables.get('maxp');
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  assert.ok(head && maxp && loca && glyf, 'the embedded font program must carry head, maxp, loca and glyf');
  const longOffsets = fontFile.readInt16BE(head.offset + 50) === 1;
  const glyphCount = fontFile.readUInt16BE(maxp.offset + 4);
  const offsetAt = (glyph) => (longOffsets
    ? fontFile.readUInt32BE(loca.offset + glyph * 4)
    : fontFile.readUInt16BE(loca.offset + glyph * 2) * 2);
  const outlineOf = (glyph) => {
    if (glyph >= glyphCount) return null;
    const from = offsetAt(glyph);
    const to = offsetAt(glyph + 1);
    return to > from ? fontFile.subarray(glyf.offset + from, glyf.offset + to) : Buffer.alloc(0);
  };
  // A composite glyph declares a negative contour count and draws nothing of its own; it names the simple
  // glyphs that carry the outlines. Counting only its own contours would score every precomposed diacritic
  // as blank, so this walks the references down. `visited` guards a font whose components form a cycle.
  const contoursOf = (glyph, visited = new Set()) => {
    if (visited.has(glyph)) return 0;
    visited.add(glyph);
    const outline = outlineOf(glyph);
    if (!outline || outline.length === 0) return 0;
    const declared = outline.readInt16BE(0);
    if (declared >= 0) return declared;
    let total = 0;
    let cursor = 10;
    let more = true;
    while (more && cursor + 4 <= outline.length) {
      const flags = outline.readUInt16BE(cursor);
      const component = outline.readUInt16BE(cursor + 2);
      cursor += 4 + ((flags & 0x0001) ? 4 : 2);
      if (flags & 0x0008) cursor += 2;
      else if (flags & 0x0040) cursor += 4;
      else if (flags & 0x0080) cursor += 8;
      more = Boolean(flags & 0x0020);
      total += contoursOf(component, visited);
    }
    return total;
  };
  return { glyphCount, outlineOf, contoursOf };
}

for (const [locale, alphabet] of Object.entries(LOCALE_ALPHABET)) {
  test(`the ${locale.toUpperCase()} dossier renders every character that locale's alphabet needs`, async () => {
    const artifacts = await buildDossierArtifacts(snapshotFor(locale));
    const objects = readIndirectObjects(artifacts.pdf);

    const font = findObject(objects, /\/Subtype\s*\/Type0/u);
    assert.ok(font, 'the dossier must show its text in an embedded composite font; a built-in base-14 font cannot carry these characters');
    assert.match(font.dict, /\/Encoding\s*\/Identity-H/u, 'the codes on the page are read as glyph indices, which only Identity-H guarantees');

    const descendantId = reference(font.dict, 'DescendantFonts');
    const descendant = objects.get(descendantId);
    assert.ok(descendant, 'the composite font must name a descendant CID font');
    assert.match(descendant.dict, /\/CIDToGIDMap\s*\/Identity/u, 'a non-identity CID-to-glyph map would make the code on the page mean a different glyph than the one checked below');

    const descriptor = objects.get(reference(descendant.dict, 'FontDescriptor'));
    assert.ok(descriptor, 'the descendant font must carry a font descriptor');
    const fontFile = objects.get(reference(descriptor.dict, 'FontFile2'));
    assert.ok(fontFile?.data?.length, 'the font program itself must be embedded, or a reader without it substitutes whatever it has');

    const toUnicodeObject = objects.get(reference(font.dict, 'ToUnicode'));
    assert.ok(toUnicodeObject?.data?.length, 'the font must carry a ToUnicode map, or the text cannot be read back out of the page at all');
    const toUnicode = parseToUnicode(toUnicodeObject.data);

    const page = findObject(objects, /\/Type\s*\/Page[^s]/u);
    assert.ok(page, 'the dossier must have a page');
    const content = objects.get(reference(page.dict, 'Contents'));
    assert.ok(content?.data?.length, 'the page must have a content stream');

    const { codes, decoded, unmapped } = decodePageText(content.data, toUnicode);
    assert.ok(codes.length > 0, 'no text was shown on the page');
    assert.deepEqual(unmapped, [], 'every code shown on the page must be reversible through the ToUnicode map');
    assert.ok(
      decoded.includes(LOCALE_TITLE[locale]),
      `the page read back must be the ${locale.toUpperCase()} document; got: ${JSON.stringify(decoded.slice(0, 120))}`,
    );

    const codeFor = new Map();
    for (const [code, character] of toUnicode) if (!codeFor.has(character)) codeFor.set(character, code);
    const glyphs = readGlyphs(fontFile.data);

    const missing = [];
    const blank = [];
    for (const character of alphabet) {
      if (!decoded.includes(character)) { missing.push(character); continue; }
      const code = codeFor.get(character);
      assert.notEqual(code, 0, `${character} resolves to .notdef rather than to a glyph of its own`);
      const outline = glyphs.outlineOf(code);
      const contours = glyphs.contoursOf(code);
      if (!outline || outline.length === 0 || contours <= 0) blank.push(`${character}=glyph${code}(bytes=${outline?.length ?? 0},contours=${contours})`);
    }
    assert.deepEqual(missing, [], `characters absent from the rendered ${locale.toUpperCase()} page: ${missing.join(' ')}`);
    assert.deepEqual(blank, [], `characters whose embedded glyph has no outline to draw: ${blank.join(' ')}`);
  });
}
