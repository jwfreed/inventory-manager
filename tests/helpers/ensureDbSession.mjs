/**
 * Helper: ensureDbSession
 * Purpose: Provide an authenticated session for db/ops tests, with SQL-backed tenant/membership seeding.
 * Preconditions: API server reachable; DATABASE_URL set; admin credentials available.
 * Postconditions: Returns { accessToken, user, tenant, role, cookies, pool } and ensures tenant membership exists.
 * Consumers: tests/db and tests/ops only.
 * Common failures: LOGIN_FAILED if admin user missing or tenant cannot be created.
 */
import { randomUUID } from 'node:crypto';
import { ensureTestServer, getBaseUrl } from '../api/helpers/testServer.mjs';
import { getDbPool } from './dbPool.mjs';

async function defaultApiRequest(method, path, { body } = {}) {
  const url = new URL(getBaseUrl() + path);
  const res = await fetch(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { res, payload };
}

export async function ensureDbSession({
  apiRequest,
  adminEmail,
  adminPassword,
  tenantSlug,
  tenantName
} = {}) {
  const request = apiRequest ?? defaultApiRequest;
  await ensureTestServer();

  const resolvedAdminEmail = adminEmail ?? process.env.SEED_ADMIN_EMAIL ?? 'jon.freed@gmail.com';
  const resolvedAdminPassword = adminPassword ?? process.env.SEED_ADMIN_PASSWORD ?? 'admin@local';
  const resolvedTenantSlug = tenantSlug ?? process.env.SEED_TENANT_SLUG ?? 'default';
  const resolvedTenantName = tenantName ?? resolvedTenantSlug;

  await request('POST', '/auth/bootstrap', {
    body: {
      adminEmail: resolvedAdminEmail,
      adminPassword: resolvedAdminPassword,
      tenantSlug: resolvedTenantSlug,
      tenantName: resolvedTenantName
    }
  });

  const pool = getDbPool();
  const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [resolvedAdminEmail]);
  if ((userRes.rowCount ?? 0) === 0) {
    throw new Error(`DB_SESSION_FAILED admin user missing for ${resolvedAdminEmail}`);
  }
  const userId = userRes.rows[0].id;

  let tenantId;
  const tenantRes = await pool.query('SELECT id FROM tenants WHERE slug = $1', [resolvedTenantSlug]);
  if ((tenantRes.rowCount ?? 0) === 0) {
    const insertTenant = await pool.query(
      `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
       VALUES ($1, $2, $3, NULL, now())
       RETURNING id`,
      [randomUUID(), resolvedTenantName, resolvedTenantSlug]
    );
    tenantId = insertTenant.rows[0].id;
  } else {
    tenantId = tenantRes.rows[0].id;
  }

  await pool.query(
    `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, created_at)
     VALUES ($1, $2, $3, 'admin', 'active', now())
     ON CONFLICT DO NOTHING`,
    [randomUUID(), tenantId, userId]
  );

  const login = await request('POST', '/auth/login', {
    body: { email: resolvedAdminEmail, password: resolvedAdminPassword, tenantSlug: resolvedTenantSlug }
  });
  if (login.res.status !== 200) {
    throw new Error(`LOGIN_FAILED status=${login.res.status} body=${JSON.stringify(login.payload)}`);
  }
  const cookies = login.res.headers.get('set-cookie') ?? '';
  return { ...login.payload, cookies, pool };
}
