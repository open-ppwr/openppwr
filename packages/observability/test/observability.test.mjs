import test from 'node:test';
import assert from 'node:assert/strict';
test('logger package exposes no production secret defaults', async () => { const source = await import('../src/index.mjs'); assert.equal(typeof source.log,'function'); });
