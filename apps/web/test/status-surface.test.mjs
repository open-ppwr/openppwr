// The status page in the only condition it exists for: the deployment not answering.
//
// `/v1/version` is the single source the page reads. When that fetch fails the build stays null, and the
// page rendered an em-dash — a blank field where a reader looking for "is this thing running" needed a
// sentence. The sentence was already written and translated in `surface-content.js` and referenced
// nowhere.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('./jsx-loader.mjs', import.meta.url);
const { StatusSurface } = await import('../src/Surfaces.jsx');
const { SURFACE_LOCALES, surfaceCommon, surfaceText } = await import('../src/surface-content.js');

// Rendered without effects, which is precisely the state under test: no build has been read, and on a
// deployment whose API is down none ever will be.
const buildPlate = (locale) => {
  const markup = renderToStaticMarkup(createElement(StatusSurface, { locale }));
  const match = /data-testid="status-build"[^>]*>([\s\S]*?)<\/aside>/u.exec(markup);
  assert.ok(match, `the build plate is rendered for ${locale}`);
  return match[1];
};

test('a status page that cannot read the build says so, in every locale', () => {
  for (const locale of SURFACE_LOCALES) {
    const plate = buildPlate(locale);
    const expected = surfaceText(surfaceCommon, locale).unavailable;
    assert.ok(expected, `${locale} has the string`);
    assert.ok(plate.includes(expected), `${locale} states that the build could not be read: ${plate}`);
    // An em-dash is not a status. It is what the page showed for weeks in place of the one fact it
    // exists to report.
    assert.ok(!/<strong>—<\/strong>/u.test(plate), `${locale} does not report the outage as a blank field`);
  }
});

test('the unreachable notice claims no cause it cannot know', () => {
  // The page cannot tell a stopped deployment from a proxy refusing the route, so it must not name
  // either. A sentence that guesses sends an operator to the wrong place.
  for (const locale of SURFACE_LOCALES) {
    const text = surfaceText(surfaceCommon, locale).unavailable;
    assert.ok(!/50\d|timeout|Zeit|proxy|Proxy|offline/u.test(text), `${locale} does not diagnose: ${text}`);
  }
});
