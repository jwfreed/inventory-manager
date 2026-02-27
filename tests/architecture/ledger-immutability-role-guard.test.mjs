import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from '../helpers/ensureDbSession.mjs';
import { stopTestServer } from '../api/helpers/testServer.mjs';

const baseUrl = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `ledger-role-guard-${randomUUID().slice(0, 8)}`;
const openPools = new Set();

function isCi() {
  const raw = String(process.env.CI ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

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
    tenantName: 'Ledger Role Guard Tenant'
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

test('app DB principal is not superuser or owner for ledger tables (strict in CI, warn locally)', async () => {
  const session = await getSession();
  const db = session.pool;

  const who = await db.query(
    `SELECT
       current_user AS current_user,
       session_user AS session_user,
       (SELECT usesuper FROM pg_user WHERE usename = current_user) AS is_superuser`
  );

  const ownership = await db.query(
    `SELECT
       c.relname AS table_name,
       pg_get_userbyid(c.relowner) AS owner_name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('inventory_movements', 'inventory_movement_lines')`
  );

  const currentUser = String(who.rows[0]?.current_user ?? '');
  const isSuperuser = Boolean(who.rows[0]?.is_superuser);
  const ownedTables = ownership.rows
    .filter((row) => row.owner_name === currentUser)
    .map((row) => row.table_name);

  const risks = [];
  if (isSuperuser) risks.push(`current_user "${currentUser}" is superuser`);
  if (ownedTables.length > 0) {
    risks.push(`current_user "${currentUser}" owns ledger table(s): ${ownedTables.join(', ')}`);
  }

  const message = [
    'LEDGER_ROLE_POSTURE_RISK detected.',
    ...risks,
    'Expected posture: app runtime DB principal is non-superuser and does not own ledger tables.'
  ].join(' ');

  if (isCi()) {
    assert.equal(risks.length, 0, message);
    return;
  }

  if (risks.length > 0) {
    console.warn(`[ledger-role-guard][warn-only-local] ${message}`);
  }
});
