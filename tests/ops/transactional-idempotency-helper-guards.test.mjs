import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const HELPER_GUARD_TIMEOUT_MS = Number(process.env.IDEMPOTENCY_HELPER_GUARD_TIMEOUT_MS ?? '120000');

function tail(text, lines = 80) {
  return String(text ?? '')
    .split(/\r?\n/)
    .slice(-lines)
    .join('\n')
    .trim();
}

async function runTypeScriptSnippet(snippet) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', '-e', snippet],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        shell: false
      }
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killHandle;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killHandle = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, HELPER_GUARD_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeoutHandle);
      clearTimeout(killHandle);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

test('transactional helper canonicalization: nested object key order hashes identically', async () => {
  const snippet = `
    const { hashTransactionalIdempotencyRequest } = require('./src/lib/transactionalIdempotency');
    const left = {
      alpha: 1,
      nested: { z: 9, a: 2, deep: { y: 1, x: 0 } },
      lines: [{ b: 2, a: 1 }, { y: 8, x: 7 }],
      nullable: null
    };
    const right = {
      nullable: null,
      lines: [{ a: 1, b: 2 }, { x: 7, y: 8 }],
      nested: { deep: { x: 0, y: 1 }, a: 2, z: 9 },
      alpha: 1
    };
    const leftHash = hashTransactionalIdempotencyRequest({ body: left });
    const rightHash = hashTransactionalIdempotencyRequest({ body: right });
    console.log(JSON.stringify({ leftHash, rightHash, equal: leftHash === rightHash }));
    process.exit(leftHash === rightHash ? 0 : 2);
  `;
  const result = await runTypeScriptSnippet(snippet);
  assert.equal(result.timedOut, false, `timed out\n${tail(result.stdout)}\n${tail(result.stderr)}`);
  assert.equal(result.code, 0, `hash mismatch\n${tail(result.stdout)}\n${tail(result.stderr)}`);
});

test('transactional helper requires explicit transaction for claim', async () => {
  const snippet = `
    const { randomUUID } = require('crypto');
    const { pool } = require('./src/db');
    const { claimTransactionalIdempotency, hashTransactionalIdempotencyRequest } = require('./src/lib/transactionalIdempotency');
    (async () => {
      const client = await pool.connect();
      try {
        await claimTransactionalIdempotency(client, {
          tenantId: randomUUID(),
          key: 'tx-guard-' + randomUUID(),
          endpoint: '/test/claim',
          requestHash: hashTransactionalIdempotencyRequest({ body: { a: 1, nested: { b: 2 } } })
        });
        console.log(JSON.stringify({ code: 'UNEXPECTED_SUCCESS' }));
        process.exitCode = 2;
      } catch (error) {
        const code = error?.code || error?.message || 'UNKNOWN';
        console.log(JSON.stringify({ code }));
        process.exitCode = code === 'IDEMPOTENCY_REQUIRES_TRANSACTION' ? 0 : 3;
      } finally {
        client.release();
        await pool.end();
      }
    })();
  `;
  const result = await runTypeScriptSnippet(snippet);
  assert.equal(result.timedOut, false, `timed out\n${tail(result.stdout)}\n${tail(result.stderr)}`);
  assert.equal(result.code, 0, `unexpected claim result\n${tail(result.stdout)}\n${tail(result.stderr)}`);
});

test('transactional helper finalize guard prevents overwrite on double finalize', async () => {
  const snippet = `
    const { randomUUID } = require('crypto');
    const { pool } = require('./src/db');
    const {
      claimTransactionalIdempotency,
      finalizeTransactionalIdempotency,
      hashTransactionalIdempotencyRequest
    } = require('./src/lib/transactionalIdempotency');
    (async () => {
      const tenantId = randomUUID();
      const key = 'tx-finalize-' + randomUUID();
      const endpoint = '/test/finalize';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await claimTransactionalIdempotency(client, {
          tenantId,
          key,
          endpoint,
          requestHash: hashTransactionalIdempotencyRequest({ body: { endpoint, tenantId } })
        });
        const first = await finalizeTransactionalIdempotency(client, {
          tenantId,
          key,
          responseStatus: 201,
          responseBody: { marker: 'first' }
        });
        const second = await finalizeTransactionalIdempotency(client, {
          tenantId,
          key,
          responseStatus: 202,
          responseBody: { marker: 'second' }
        });
        const row = await client.query(
          'SELECT response_status, response_body FROM idempotency_keys WHERE tenant_id = $1 AND key = $2',
          [tenantId, key]
        );
        await client.query('ROLLBACK');
        const storedStatus = Number(row.rows[0]?.response_status ?? 0);
        const storedMarker = row.rows[0]?.response_body?.marker ?? null;
        const ok = first?.alreadyFinalized === false
          && second?.alreadyFinalized === true
          && storedStatus === 201
          && storedMarker === 'first';
        console.log(JSON.stringify({ first, second, storedStatus, storedMarker, ok }));
        process.exitCode = ok ? 0 : 4;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.log(JSON.stringify({ code: error?.code || error?.message || 'UNKNOWN' }));
        process.exitCode = 3;
      } finally {
        client.release();
        await pool.end();
      }
    })();
  `;
  const result = await runTypeScriptSnippet(snippet);
  assert.equal(result.timedOut, false, `timed out\n${tail(result.stdout)}\n${tail(result.stderr)}`);
  assert.equal(result.code, 0, `finalize guard failed\n${tail(result.stdout)}\n${tail(result.stderr)}`);
});
