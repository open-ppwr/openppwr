// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { ClamAvScanner } from '../../apps/worker/src/index.mjs';

const host = process.env.OPENPPWR_CLAMAV_HOST || '127.0.0.1';
const port = Number(process.env.OPENPPWR_CLAMAV_PORT || 3310);
const scanner = new ClamAvScanner({ host, port, timeoutMs: 30_000 });
const clean = await scanner.scan(Buffer.from('Synthetic ACME clean scanner validation.'));
assert.equal(clean.status, 'clean');

const eicarParts = ['X5O!P%@AP', '[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'];
const infected = await scanner.scan(Buffer.from(eicarParts.join('')));
assert.equal(infected.status, 'infected');

console.log(`CLAMAV_RUNTIME_PASS host=${host} port=${port} clean=clean test_signature=infected content_logged=false`);
