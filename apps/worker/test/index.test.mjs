import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import {

  ClamAvScanner,
  VerdictStubScanner,
  authenticateWorker,
  assertSingleTenantDeployment,
  loadWorkerConfig,
  processNextScanJob,
  resolveStoragePath,
  resolveTenantStoragePath,
  runPollingLoop,
  tombstonePath,
} from '../src/index.mjs';

// A credential shaped like the one bootstrap mints. The fixtures used the five-character string
// 'token', which `assertStrongSecrets` now refuses — correctly, and the fixture was the unrealistic
// part.
const WORKER_TOKEN = ['opp_', 'test_', 'b7Kq2mXr', '9TfLp4Zc', '8VnD6Hsw'].join('');

async function withClamServer(handler, operation) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    handler(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await operation(server.address().port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function replyWith(response) {
  return (socket) => {
    let request = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      request = Buffer.concat([request, chunk]);
      const command = Buffer.from('zINSTREAM\0', 'ascii');
      if (request.length < command.length) return;
      if (!request.subarray(0, command.length).equals(command)) {
        socket.end('malformed request\0');
        return;
      }
      let offset = command.length;
      while (offset + 4 <= request.length) {
        const size = request.readUInt32BE(offset);
        offset += 4;
        if (size === 0) {
          if (offset === request.length) socket.end(`${response}\0`);
          return;
        }
        if (offset + size > request.length) return;
        offset += size;
      }
    });
  };
}

test('deterministic scanner cannot run under production runtime', () => {
  assert.throws(() => new VerdictStubScanner({ runtime: 'production' }), /test-only/);
});

test('deterministic scanner distinguishes clean and safe infected marker', async () => {
  const scanner = new VerdictStubScanner({ runtime: 'test' });
  assert.equal((await scanner.scan(Buffer.from('synthetic clean'))).status, 'clean');
  assert.equal((await scanner.scan(Buffer.from('synthetic EICAR marker'))).status, 'infected');
});

test('ClamAV INSTREAM adapter handles clean and infected responses', async () => {
  await withClamServer(replyWith('stream: OK'), async (port) => {
    const result = await new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 500 }).scan(Buffer.from('synthetic clean'));
    assert.deepEqual(result, { status: 'clean', engine: 'clamav' });
  });
  await withClamServer(replyWith('stream: Synthetic-Test-Signature FOUND'), async (port) => {
    const result = await new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 500 }).scan(Buffer.from('synthetic infected'));
    assert.deepEqual(result, { status: 'infected', engine: 'clamav' });
  });
});

test('ClamAV adapter fails closed on timeout, unavailable and malformed response', async () => {
  await withClamServer(() => {}, async (port) => {
    await assert.rejects(
      new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 30 }).scan(Buffer.from('synthetic timeout')),
      { code: 'MALWARE_SCAN_TIMEOUT' },
    );
  });
  let unavailablePort;
  await withClamServer(() => {}, async (port) => { unavailablePort = port; });
  await assert.rejects(
    new ClamAvScanner({ host: '127.0.0.1', port: unavailablePort, timeoutMs: 100 }).scan(Buffer.from('synthetic unavailable')),
    { code: 'MALWARE_SCANNER_UNAVAILABLE' },
  );
  await withClamServer(replyWith('unexpected scanner output'), async (port) => {
    await assert.rejects(
      new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 500 }).scan(Buffer.from('synthetic malformed')),
      { code: 'MALWARE_SCANNER_MALFORMED_RESPONSE' },
    );
  });
  await withClamServer(replyWith('X'.repeat(5000)), async (port) => {
    await assert.rejects(
      new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 500 }).scan(Buffer.from('synthetic oversized response')),
      { code: 'MALWARE_SCANNER_MALFORMED_RESPONSE' },
    );
  });
});

test('ClamAV adapter rejects oversized input before network transmission', async () => {
  const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 3310, timeoutMs: 100, maxBytes: 4 });
  await assert.rejects(scanner.scan(Buffer.from('12345')), { code: 'MALWARE_SCAN_SIZE_EXCEEDED' });
});

test('storage paths cannot escape configured root', () => {
  const root = 'D:/synthetic/evidence';
  assert.match(resolveStoragePath(root, 'tenant/quarantine/file.pdf'), /file\.pdf$/);
  assert.throws(() => resolveStoragePath(root, '../outside.pdf'), { code: 'STORAGE_PATH_INVALID' });
  assert.throws(() => resolveStoragePath(root, 'D:/outside.pdf'), { code: 'STORAGE_PATH_INVALID' });
  assert.match(resolveTenantStoragePath(root, 'tenant-a', 'tenant-a/quarantine/file.pdf').target, /file\.pdf$/);
  assert.throws(() => resolveTenantStoragePath(root, 'tenant-a', 'tenant-b/quarantine/file.pdf'), { code: 'STORAGE_PATH_INVALID' });
  assert.throws(() => resolveTenantStoragePath(root, 'tenant-a', 'tenant-a/quarantine/nested/file.pdf'), { code: 'STORAGE_PATH_INVALID' });
});

test('retention tombstones are isolated by evidence and operation identifiers', () => {
  const root = 'D:/synthetic/evidence';
  const first = tombstonePath(root, 'evidence-a', 'operation-a');
  const second = tombstonePath(root, 'evidence-b', 'operation-a');
  assert.match(first, /[\\/]?\.openppwr-retention-tombstones[\\/]evidence-a[\\/]operation-a$/u);
  assert.notEqual(first, second);
  assert.throws(() => tombstonePath(root, 'evidence-a', null), { code: 'RETENTION_FENCE_INVALID' });
});

test('worker authentication accepts only a database-verified worker bearer token', async () => {
  const workerPool = { query: async () => ({ rowCount: 1, rows: [{ tenant_id: 'tenant', actor_id: 'actor', actor_role: 'worker', supplier_id: null }] }) };
  assert.equal((await authenticateWorker(workerPool, 'verified-token')).role, 'worker');
  const humanPool = { query: async () => ({ rowCount: 1, rows: [{ tenant_id: 'tenant', actor_id: 'actor', actor_role: 'tenant_admin', supplier_id: null }] }) };
  await assert.rejects(authenticateWorker(humanPool, 'human-token'), { code: 'WORKER_AUTHORIZATION_REQUIRED' });
  const invalidPool = { query: async () => ({ rowCount: 0, rows: [] }) };
  await assert.rejects(authenticateWorker(invalidPool, 'invalid-token'), { code: 'WORKER_AUTHENTICATION_FAILED' });
});

test('job processing rejects unverified and non-worker identities', async () => {
  await assert.rejects(processNextScanJob({ pool: {}, identity: null, storageRoot: '.', scanner: { scan() {} } }), { code: 'WORKER_AUTHORIZATION_REQUIRED' });
  await assert.rejects(processNextScanJob({ pool: {}, identity: { tenantId: 'tenant', actorId: 'actor', role: 'tenant_admin' }, storageRoot: '.', scanner: { scan() {} } }), { code: 'WORKER_AUTHORIZATION_REQUIRED' });
});

test('worker configuration fails clearly for missing or invalid required values', () => {
  assert.throws(() => loadWorkerConfig({}), /OPENPPWR_DATABASE_URL/);
  assert.throws(() => loadWorkerConfig({ OPENPPWR_DATABASE_URL: 'postgres://synthetic', OPENPPWR_WORKER_TOKEN: WORKER_TOKEN, OPENPPWR_EVIDENCE_STORAGE_ROOT: '/evidence', OPENPPWR_CLAMAV_HOST: 'clamav', OPENPPWR_CLAMAV_PORT: '0' }), /OPENPPWR_CLAMAV_PORT/);
  const config = loadWorkerConfig({ OPENPPWR_DATABASE_URL: 'postgres://synthetic', OPENPPWR_WORKER_TOKEN: WORKER_TOKEN, OPENPPWR_EVIDENCE_STORAGE_ROOT: '/evidence', OPENPPWR_CLAMAV_HOST: 'clamav' });
  assert.equal(config.clamav.port, 3310);
  assert.equal(config.pollIntervalMs, 1000);
  assert.equal(config.healthPort, 3000);
});

test('polling loop stops gracefully after abort', async () => {
  const controller = new AbortController();
  let calls = 0;
  await runPollingLoop({
    signal: controller.signal,
    pollIntervalMs: 1,
    processJob: async () => {
      calls += 1;
      controller.abort();
      return null;
    },
  });
  assert.equal(calls, 1);
});

// --- one tenant per deployment ------------------------------------------------------------------
// The Community deployment serves one tenant. A single worker can only process the tenant its own token
// belongs to, so a database holding several would leave every other tenant's evidence stuck in `pending`
// permanently — which is how the limit was discovered. The worker therefore refuses to start rather than
// service a topology it cannot honestly cover.

const tenantCountPool = (total) => ({ query: async () => ({ rows: [{ total }] }) });

test('a worker starts when the deployment holds one tenant', async () => {
  const result = await assertSingleTenantDeployment(tenantCountPool(1));
  assert.deepEqual(result, { tenants: 1, enforced: true });
});

test('a worker starts before bootstrap, when no tenant exists yet', async () => {
  // Startup order is not guaranteed: the worker may come up before the operator has bootstrapped.
  // Zero tenants is not a misconfiguration, so it must not be treated as one.
  const result = await assertSingleTenantDeployment(tenantCountPool(0));
  assert.deepEqual(result, { tenants: 0, enforced: true });
});

test('a worker refuses to start when the deployment holds more than one tenant', async () => {
  await assert.rejects(
    () => assertSingleTenantDeployment(tenantCountPool(2)),
    (error) => {
      assert.equal(error.code, 'WORKER_MULTI_TENANT_DEPLOYMENT_UNSUPPORTED');
      // The message has to tell an operator what to do, not merely that something is wrong.
      assert.match(error.message, /one tenant per deployment/);
      assert.match(error.message, /never be scanned/);
      return true;
    },
  );
});

test('the multi-tenant opt-out is explicit, and only the exact string enables it', async () => {
  const permitted = await assertSingleTenantDeployment(tenantCountPool(3), { allowMultiTenantDatabase: true });
  assert.deepEqual(permitted, { tenants: 3, enforced: false });
  // Anything other than the opt-out still fails closed: a truthy-looking value must not silently disable
  // a safety check.
  for (const value of [false, undefined, 'yes', '1']) {
    await assert.rejects(() => assertSingleTenantDeployment(tenantCountPool(3), { allowMultiTenantDatabase: value }));
  }
});

test('the opt-out is only enabled by the exact environment string', () => {
  const base = { OPENPPWR_DATABASE_URL: 'postgres://synthetic', OPENPPWR_WORKER_TOKEN: WORKER_TOKEN, OPENPPWR_EVIDENCE_STORAGE_ROOT: '/evidence', OPENPPWR_CLAMAV_HOST: 'clamav' };
  assert.equal(loadWorkerConfig(base).allowMultiTenantDatabase, false);
  assert.equal(loadWorkerConfig({ ...base, OPENPPWR_ALLOW_UNSUPPORTED_MULTI_TENANT_DATABASE: 'TRUE' }).allowMultiTenantDatabase, false);
  assert.equal(loadWorkerConfig({ ...base, OPENPPWR_ALLOW_UNSUPPORTED_MULTI_TENANT_DATABASE: '1' }).allowMultiTenantDatabase, false);
  assert.equal(loadWorkerConfig({ ...base, OPENPPWR_ALLOW_UNSUPPORTED_MULTI_TENANT_DATABASE: 'true' }).allowMultiTenantDatabase, true);
});

// --- the tenancy invariant is rechecked while running ---------------------------------------------
// The startup-only check was a real gap: a tenant created after the worker began was never noticed, so
// the unsupported topology could appear silently on a running deployment.

test('the tenancy recheck interval is configurable and bounded', () => {
  const base = { OPENPPWR_DATABASE_URL: 'postgres://synthetic', OPENPPWR_WORKER_TOKEN: WORKER_TOKEN, OPENPPWR_EVIDENCE_STORAGE_ROOT: '/evidence', OPENPPWR_CLAMAV_HOST: 'clamav' };
  assert.equal(loadWorkerConfig(base).tenancyRecheckMs, 60_000);
  assert.equal(loadWorkerConfig({ ...base, OPENPPWR_WORKER_TENANCY_RECHECK_MS: '5000' }).tenancyRecheckMs, 5000);
  // Bounded on both sides: a zero interval would run a counting query every poll, and an unbounded one
  // would let an operator disable the recheck by setting it beyond any process lifetime.
  assert.throws(() => loadWorkerConfig({ ...base, OPENPPWR_WORKER_TENANCY_RECHECK_MS: '0' }), /TENANCY_RECHECK/);
  assert.throws(() => loadWorkerConfig({ ...base, OPENPPWR_WORKER_TENANCY_RECHECK_MS: '999999999' }), /TENANCY_RECHECK/);
});

test('a tenant appearing after startup is detected by the recheck, not ignored', async () => {
  // The database grows a second tenant between calls. The first call is the startup check and passes; the
  // second is the recheck and must refuse, because that is the whole point of rechecking.
  let tenants = 1;
  const pool = { query: async () => ({ rows: [{ total: tenants }] }) };

  const first = await assertSingleTenantDeployment(pool);
  assert.deepEqual(first, { tenants: 1, enforced: true });

  tenants = 2;
  await assert.rejects(
    () => assertSingleTenantDeployment(pool),
    (error) => {
      assert.equal(error.code, 'WORKER_MULTI_TENANT_DEPLOYMENT_UNSUPPORTED');
      return true;
    },
  );
});
