import { Pool } from 'pg';
import { ensureTestServer, getBaseUrl } from './testServer.mjs';

let sharedPool;

function getSharedPool() {
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return sharedPool;
}

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

export async function ensureSession({
  apiRequest,
  adminEmail,
  adminPassword,
  tenantSlug,
  tenantName
} = {}) {
  const pool = getSharedPool();
  const request = apiRequest ?? defaultApiRequest;
  await ensureTestServer();
  const resolvedAdminEmail = adminEmail ?? process.env.SEED_ADMIN_EMAIL ?? 'jon.freed@gmail.com';
  const resolvedAdminPassword = adminPassword ?? process.env.SEED_ADMIN_PASSWORD ?? 'admin@local';
  const resolvedTenantSlug = tenantSlug ?? process.env.SEED_TENANT_SLUG ?? 'default';
  const resolvedTenantName = tenantName ?? resolvedTenantSlug;
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

  const login = await request('POST', '/auth/login', {
    body: { email: resolvedAdminEmail, password: resolvedAdminPassword, tenantSlug: resolvedTenantSlug }
  });

  if (login.res.status !== 200) {
    throw new Error(
      `LOGIN_FAILED status=${login.res.status} body=${JSON.stringify(login.payload)}`
    );
  }
  const cookies = login.res.headers.get('set-cookie') ?? '';
  return { ...login.payload, cookies, pool };
}
