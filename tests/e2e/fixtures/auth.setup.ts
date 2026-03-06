import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test as setup, type Page } from '@playwright/test';
import { loadE2EEnv, type E2EEnv } from './env';

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

async function ensureBootstrapAccountIfNeeded(args: {
  page: Page;
  env: E2EEnv;
  uiOrigin: string;
  apiOrigin: string;
}) {
  if (args.env.credentials.source !== 'bootstrap_fallback') {
    return;
  }

  if (args.env.credentials.resolutionMessage) {
    console.info(args.env.credentials.resolutionMessage);
  }

  const bootstrapPayload = {
    adminEmail: args.env.credentials.email,
    adminPassword: args.env.credentials.password,
    tenantSlug: args.env.tenantSlug ?? 'default',
    tenantName: args.env.tenantName ?? 'Default Tenant'
  };

  await args.page.evaluate(
    async ({ apiBaseURL, payload, uiOrigin, apiOrigin }) => {
      let response: Response;
      try {
        response = await fetch(`${apiBaseURL}/auth/bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload)
        });
      } catch (error) {
        throw new Error(
          [
            `E2E auth bootstrap request failed from ${uiOrigin} to ${apiOrigin}.`,
            'Likely CORS mismatch. Ensure CORS_ORIGIN/CORS_ORIGINS includes the UI origin.',
            `Original error: ${error instanceof Error ? error.message : String(error)}`
          ].join(' ')
        );
      }

      const rawBody = await response.text();
      let parsedBody: unknown = null;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
      }

      if (response.status === 201 || response.status === 409) {
        return;
      }

      const printableBody = typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody);
      throw new Error(
        [
          `E2E auth bootstrap failed (${response.status}).`,
          `API response: ${printableBody || '<empty>'}.`,
          'Verify API is running and /auth/bootstrap is reachable.'
        ].join(' ')
      );
    },
    {
      apiBaseURL: args.env.apiBaseURL,
      payload: bootstrapPayload,
      uiOrigin: args.uiOrigin,
      apiOrigin: args.apiOrigin
    }
  );
}

setup('authenticate and persist storage state', async ({ page }) => {
  const env = loadE2EEnv();
  const uiOrigin = new URL(env.baseURL).origin;
  const apiOrigin = new URL(env.apiBaseURL).origin;

  await mkdir(authDir, { recursive: true });

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login$/);

  await ensureBootstrapAccountIfNeeded({
    page,
    env,
    uiOrigin,
    apiOrigin
  });

  const loginPayload: Record<string, string> = {
    email: env.credentials.email,
    password: env.credentials.password
  };
  if (env.tenantSlug) {
    loginPayload.tenantSlug = env.tenantSlug;
  }

  const session = (await page.evaluate(
    async ({ apiBaseURL, payload, uiOrigin, apiOrigin }) => {
      let response: Response;
      try {
        response = await fetch(`${apiBaseURL}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload)
        });
      } catch (error) {
        throw new Error(
          [
            `E2E auth login request failed from ${uiOrigin} to ${apiOrigin}.`,
            'Likely CORS mismatch. Ensure CORS_ORIGIN/CORS_ORIGINS includes the UI origin.',
            `Original error: ${error instanceof Error ? error.message : String(error)}`
          ].join(' ')
        );
      }

      const rawBody = await response.text();
      let parsedBody: unknown = null;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
      }

      if (!response.ok) {
        const printableBody = typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody);
        throw new Error(
          [
            `E2E auth login failed (${response.status}).`,
            `API response: ${printableBody || '<empty>'}.`,
            'Verify E2E_USER/E2E_PASS or SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD and tenant membership,',
            'or use the bootstrap fallback account path with a reachable /auth/bootstrap endpoint.'
          ].join(' ')
        );
      }

      if (!parsedBody || typeof parsedBody !== 'object') {
        throw new Error('E2E auth login succeeded but response body was empty or non-JSON.');
      }

      const accessToken = (parsedBody as { accessToken?: unknown }).accessToken;
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new Error('E2E auth login succeeded but no accessToken was returned.');
      }

      return parsedBody;
    },
    { apiBaseURL: env.apiBaseURL, payload: loginPayload, uiOrigin, apiOrigin }
  )) as AuthSession;

  await page.evaluate((token) => {
    window.localStorage.setItem('inventory.accessToken', token);
  }, session.accessToken);

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  const storageState = await page.context().storageState({ path: storageStatePath });
  const hasRefreshCookie = storageState.cookies.some((cookie) => cookie.name === 'refresh_token');
  if (!hasRefreshCookie) {
    throw new Error(
      [
        'E2E auth setup did not capture refresh_token cookie in browser storageState.',
        `UI origin=${uiOrigin}. API origin=${apiOrigin}.`,
        'Verify login uses browser fetch with credentials: include and API CORS allows this UI origin.'
      ].join(' ')
    );
  }

  const authRequest = page.context().request;

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
