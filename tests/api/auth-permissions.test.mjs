import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureSession } from './helpers/ensureSession.mjs';
import { getBaseUrl } from './helpers/testServer.mjs';

const adminEmail = process.env.SEED_ADMIN_EMAIL || 'jon.freed@gmail.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin@local';
const tenantSlug = `auth-permissions-${Date.now().toString(36)}`;

async function apiRequest(method, path, { token, body } = {}) {
  const url = new URL(getBaseUrl() + path);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => '');
  return { res, payload };
}

test('/auth/me exposes role and role-derived permissions for frontend UI gating', async () => {
  const session = await ensureSession({
    apiRequest,
    adminEmail,
    adminPassword,
    tenantSlug,
    tenantName: 'Auth Permissions Tenant'
  });

  assert.equal(session.role, 'admin');
  assert.ok(Array.isArray(session.permissions), 'login session should include permissions');
  assert.ok(session.permissions.includes('admin:imports'));
  assert.ok(session.permissions.includes('inventory:adjustments:post'));

  const { res, payload } = await apiRequest('GET', '/auth/me', { token: session.accessToken });
  assert.equal(res.status, 200, JSON.stringify(payload));
  assert.equal(payload.role, 'admin');
  assert.ok(Array.isArray(payload.permissions), '/auth/me should include permissions');
  assert.deepEqual([...payload.permissions].sort(), [...session.permissions].sort());
  assert.ok(payload.user?.id);
  assert.ok(payload.tenant?.id);
});
