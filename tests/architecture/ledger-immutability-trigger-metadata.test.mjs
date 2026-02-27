import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { stopTestServer } from '../api/helpers/testServer.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `ledger-trigger-meta-${randomUUID().slice(0, 8)}`;
const openPools = new Set();

async function apiRequest(method, path, { token, body, params, headers } = {}) {
  const url = new URL(baseUrl + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const mergedHeaders = { 'Content-Type': 'application/json', ...(headers ?? {}) };
  if (token) mergedHeaders.Authorization = `Bearer ${token}`;

  const res = await fetch(url.toString(), {
    method,
    headers: mergedHeaders,
    body: body ? JSON.stringify(body) : undefined
  });

  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => '');

  return { res, payload };
}

async function getSession() {
  const session = await ensureDbSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Ledger Trigger Metadata Guard Tenant'
  });
  if (session.pool) openPools.add(session.pool);
  return session;
}

test.after(async () => {
  await Promise.all(
    Array.from(openPools).map(async (pool) => {
      try {
        await pool.end();
      } catch {
        // Ignore teardown failures.
      }
    })
  );
  openPools.clear();
  await stopTestServer();
});

test('ledger immutability triggers exist, are enabled, and bind to prevent_ledger_mutation', async () => {
  const session = await getSession();
  const db = session.pool;

  const { rows } = await db.query(
    `SELECT
        c.relname AS table_name,
        t.tgname AS trigger_name,
        t.tgenabled AS enabled_state,
        p.proname AS function_name,
        pg_get_triggerdef(t.oid, true) AS trigger_def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public'
        AND c.relname IN ('inventory_movements', 'inventory_movement_lines')
        AND NOT t.tgisinternal`
  );

  const byName = new Map(rows.map((row) => [row.trigger_name, row]));
  const expected = [
    {
      name: 'inventory_movements_no_update',
      table: 'inventory_movements',
      defContains: ['BEFORE UPDATE', 'FOR EACH ROW', 'EXECUTE FUNCTION prevent_ledger_mutation()']
    },
    {
      name: 'inventory_movements_no_delete',
      table: 'inventory_movements',
      defContains: ['BEFORE DELETE', 'FOR EACH ROW', 'EXECUTE FUNCTION prevent_ledger_mutation()']
    },
    {
      name: 'inventory_movement_lines_no_update',
      table: 'inventory_movement_lines',
      defContains: ['BEFORE UPDATE', 'FOR EACH ROW', 'EXECUTE FUNCTION prevent_ledger_mutation()']
    },
    {
      name: 'inventory_movement_lines_no_delete',
      table: 'inventory_movement_lines',
      defContains: ['BEFORE DELETE', 'FOR EACH ROW', 'EXECUTE FUNCTION prevent_ledger_mutation()']
    }
  ];

  for (const exp of expected) {
    const row = byName.get(exp.name);
    assert.ok(row, `Missing trigger: ${exp.name} on ${exp.table}`);
    assert.equal(row.table_name, exp.table, `Trigger ${exp.name} bound to wrong table`);
    assert.notEqual(row.enabled_state, 'D', `Trigger ${exp.name} is disabled (tgenabled='D')`);
    assert.equal(
      row.function_name,
      'prevent_ledger_mutation',
      `Trigger ${exp.name} bound to wrong function: ${row.function_name}`
    );
    const def = String(row.trigger_def || '');
    for (const token of exp.defContains) {
      assert.ok(def.includes(token), `Trigger ${exp.name} definition missing "${token}". Actual: ${def}`);
    }
  }
});
