import { Pool } from 'pg';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureTestServer, getBaseUrl } from './testServer.mjs';

let sharedPool;
const sessionsByScope = new Map();
const inFlightByScope = new Map();

function getSharedPool() {
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return sharedPool;
}

export async function closeEnsureSessionPool() {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
}

function getTestScopeKey() {
  const stack = new Error().stack ?? '';
  const lines = stack.split('\n').slice(1);
  for (const line of lines) {
    const match =
      line.match(/\((.*tests\/api\/.*\.test\.mjs):\d+:\d+\)/) ||
      line.match(/at (.*tests\/api\/.*\.test\.mjs):\d+:\d+/);
    if (match && match[1]) return match[1];
  }
  return `unknown-${process.pid}`;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function buildTenantSlug(scopePath) {
  const base = path.basename(scopePath, '.test.mjs');
  const hash = createHash('sha1').update(scopePath).digest('hex').slice(0, 8);
  return slugify(`test-${base}-${hash}-${process.pid}`);
}

function buildScopedTenantSlug(base, scopePath) {
  const hash = createHash('sha1').update(scopePath).digest('hex').slice(0, 8);
  return slugify(`${base}-${hash}-${process.pid}`);
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
  const scopeKey = getTestScopeKey();
  const pool = getSharedPool();
  const request = apiRequest ?? defaultApiRequest;
  await ensureTestServer();
  const resolvedAdminEmail = adminEmail ?? process.env.SEED_ADMIN_EMAIL ?? 'jon.freed@gmail.com';
  const resolvedAdminPassword = adminPassword ?? process.env.SEED_ADMIN_PASSWORD ?? 'admin@local';
  const requestedTenantSlug = tenantSlug ?? process.env.SEED_TENANT_SLUG;
  const resolvedTenantSlug = requestedTenantSlug
    ? (requestedTenantSlug === 'default' || requestedTenantSlug === process.env.SEED_TENANT_SLUG
      ? buildScopedTenantSlug(requestedTenantSlug, scopeKey)
      : requestedTenantSlug)
    : buildTenantSlug(scopeKey);
  const resolvedTenantName = tenantName ?? resolvedTenantSlug;
  const cacheKey = `${scopeKey}::${resolvedTenantSlug}`;

  if (sessionsByScope.has(cacheKey)) {
    return sessionsByScope.get(cacheKey);
  }
  if (inFlightByScope.has(cacheKey)) {
    return inFlightByScope.get(cacheKey);
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
      if (login.res.status === 400 || login.res.status === 401) {
        const tenantRes = await pool.query(
          `SELECT id FROM tenants WHERE slug = $1`,
          [resolvedTenantSlug]
        );
        if ((tenantRes.rowCount ?? 0) === 0) {
          await pool.query(
            `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
             VALUES (gen_random_uuid(), $1, $2, NULL, now())`,
            [resolvedTenantName, resolvedTenantSlug]
          );
        }
        await request('POST', '/auth/bootstrap', {
          body: {
            adminEmail: resolvedAdminEmail,
            adminPassword: resolvedAdminPassword,
            tenantSlug: resolvedTenantSlug,
            tenantName: resolvedTenantName
          }
        });
        login = await request('POST', '/auth/login', {
          body: { email: resolvedAdminEmail, password: resolvedAdminPassword, tenantSlug: resolvedTenantSlug }
        });
      }
    }

    if (login.res.status !== 200) {
      throw new Error(
        `LOGIN_FAILED status=${login.res.status} body=${JSON.stringify(login.payload)}`
      );
    }
    const cookies = login.res.headers.get('set-cookie') ?? '';
    const session = { ...login.payload, cookies, pool };
    sessionsByScope.set(cacheKey, session);
    return session;
  })();

  inFlightByScope.set(cacheKey, sessionPromise);
  try {
    return await sessionPromise;
  } finally {
    inFlightByScope.delete(cacheKey);
  }
}
