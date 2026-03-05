import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { loadE2EEnv } from './env';

type AuthSession = {
  accessToken: string;
  user?: { id?: string; email?: string };
  tenant?: { id?: string; slug?: string; name?: string };
  role?: string;
};

type AuthMeResponse = {
  user: { id: string; email: string };
  tenant: { id: string; slug: string; name: string };
  role?: string;
};

const authDir = path.resolve(process.cwd(), 'playwright/.auth');
const storageStatePath = path.resolve(authDir, 'user.json');
const authMetaPath = path.resolve(authDir, 'meta.json');

setup('authenticate and persist storage state', async ({ page }) => {
  const env = loadE2EEnv();

  await mkdir(authDir, { recursive: true });

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login$/);

  const loginPayload: Record<string, string> = {
    email: env.credentials.email,
    password: env.credentials.password
  };
  if (env.tenantSlug) {
    loginPayload.tenantSlug = env.tenantSlug;
  }

  const authRequest = page.context().request;

  const loginResponse = await authRequest.post(`${env.apiBaseURL}/auth/login`, {
    data: loginPayload
  });

  if (!loginResponse.ok()) {
    const body = await loginResponse.text();
    throw new Error(
      [
        `E2E auth login failed (${loginResponse.status()}).`,
        `API response: ${body || '<empty>'}.`,
        'Verify E2E_USER/E2E_PASS or SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD and tenant membership.'
      ].join(' ')
    );
  }

  const session = (await loginResponse.json()) as AuthSession;
  if (!session.accessToken) {
    throw new Error('E2E auth login succeeded but no accessToken was returned.');
  }

  await page.evaluate((token) => {
    window.localStorage.setItem('inventory.accessToken', token);
  }, session.accessToken);

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page.context().storageState({ path: storageStatePath });

  const meResponse = await authRequest.get(`${env.apiBaseURL}/auth/me`, {
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });

  if (!meResponse.ok()) {
    const body = await meResponse.text();
    throw new Error(`E2E /auth/me lookup failed (${meResponse.status()}): ${body}`);
  }

  const me = (await meResponse.json()) as AuthMeResponse;
  await writeFile(
    authMetaPath,
    JSON.stringify(
      {
        accessToken: session.accessToken,
        user: me.user,
        tenant: me.tenant,
        role: me.role ?? session.role ?? null,
        generatedAt: new Date().toISOString()
      },
      null,
      2
    ),
    'utf8'
  );
});
