/**
 * Helper: ensureSession
 * Purpose: Provision an authenticated API session for tests against a configured tenant.
 * Preconditions: API server reachable; migrations applied; DATABASE_URL available for tenant fallback.
 * Postconditions: Returns { token, cookies, tenant info } scoped to the calling test file.
 * Consumers: API tests.
 * Common failures: BOOTSTRAP_FAILED on unexpected status, LOGIN_FAILED on bad credentials, missing server (/healthz).
 */
import { randomUUID } from 'node:crypto';
import { ensureTestServer, getBaseUrl } from './testServer.mjs';
import { getDbPool } from '../../helpers/dbPool.mjs';

const sessionsByTenant = new Map();
const inFlightByTenant = new Map();

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

async function ensureTenantMembership(adminEmail, tenantSlug, tenantName) {
  const pool = getDbPool();
  const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
  if ((userRes.rowCount ?? 0) === 0) {
    throw new Error(`API_SESSION_FAILED admin user missing for ${adminEmail}`);
  }

  const tenantRes = await pool.query('SELECT id FROM tenants WHERE slug = $1', [tenantSlug]);
  const tenantId = tenantRes.rows[0]?.id ?? (
    await pool.query(
      `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
       VALUES ($1, $2, $3, NULL, now())
       RETURNING id`,
      [randomUUID(), tenantName, tenantSlug]
    )
  ).rows[0].id;

  await pool.query(
    `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, created_at)
     VALUES ($1, $2, $3, 'admin', 'active', now())
     ON CONFLICT DO NOTHING`,
    [randomUUID(), tenantId, userRes.rows[0].id]
  );
}

export async function ensureSession({
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

  if (sessionsByTenant.has(resolvedTenantSlug)) {
    return sessionsByTenant.get(resolvedTenantSlug);
  }
  if (inFlightByTenant.has(resolvedTenantSlug)) {
    return inFlightByTenant.get(resolvedTenantSlug);
  }

  const sessionPromise = (async () => {
    const bootstrap = await request('POST', '/auth/bootstrap', {
      body: {
        adminEmail: resolvedAdminEmail,
        adminPassword: resolvedAdminPassword,
        tenantSlug: resolvedTenantSlug,
        tenantName: resolvedTenantName
      }
    });
    if (!bootstrap.res.ok && bootstrap.res.status !== 409) {
      throw new Error(
        `BOOTSTRAP_FAILED status=${bootstrap.res.status} body=${JSON.stringify(bootstrap.payload)}`
      );
    }

    let login = await request('POST', '/auth/login', {
      body: { email: resolvedAdminEmail, password: resolvedAdminPassword, tenantSlug: resolvedTenantSlug }
    });

    if (login.res.status !== 200) {
      await ensureTenantMembership(
        resolvedAdminEmail,
        resolvedTenantSlug,
        resolvedTenantName
      );
      login = await request('POST', '/auth/login', {
        body: { email: resolvedAdminEmail, password: resolvedAdminPassword, tenantSlug: resolvedTenantSlug }
      });
    }

    if (login.res.status !== 200) {
      throw new Error(
        `LOGIN_FAILED status=${login.res.status} body=${JSON.stringify(login.payload)} ` +
        `tenantSlug=${resolvedTenantSlug}. ` +
        `Ensure SEED_TENANT_SLUG points to an existing tenant with admin membership. ` +
        `DB/ops tests should use ensureDbSession for tenant seeding.`
      );
    }
    const cookies = login.res.headers.get('set-cookie') ?? '';
    const session = { ...login.payload, cookies };
    sessionsByTenant.set(resolvedTenantSlug, session);
    return session;
  })();

  inFlightByTenant.set(resolvedTenantSlug, sessionPromise);
  try {
    return await sessionPromise;
  } finally {
    inFlightByTenant.delete(resolvedTenantSlug);
  }
}
