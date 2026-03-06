import { createHmac } from 'node:crypto';
import type { Page, Response as PWResponse } from '@playwright/test';
import { test, expect } from '../fixtures/test';

type RefreshCall = {
  url: string;
  method: string;
  status: number;
};

type AuthRefreshEnv = {
  apiBaseURL: string;
  tenantSlug?: string;
  tenantName?: string;
  credentials: {
    email: string;
    password: string;
    source: string;
    resolutionMessage?: string;
  };
};

function encodeBase64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function mintExpiredAccessToken(args: {
  jwtSecret: string;
  userId: string;
  tenantId: string;
  role: string;
}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: args.userId,
    tenantId: args.tenantId,
    role: args.role,
    iat: nowSeconds - 600,
    exp: nowSeconds - 300
  };

  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', args.jwtSecret)
    .update(signingInput)
    .digest('base64url');

  return `${signingInput}.${signature}`;
}

function isRefreshEndpoint(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/auth/refresh');
  } catch {
    return false;
  }
}

async function ensureBootstrapAccountIfNeeded(args: { page: Page; env: AuthRefreshEnv }) {
  if (args.env.credentials.source !== 'bootstrap_fallback') {
    return;
  }

  await args.page.evaluate(
    async ({ apiBaseURL, email, password, tenantSlug, tenantName }) => {
      const response = await fetch(`${apiBaseURL}/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          adminEmail: email,
          adminPassword: password,
          tenantSlug: tenantSlug || 'default',
          tenantName: tenantName || 'Default Tenant'
        })
      });

      if (response.status === 201 || response.status === 409) {
        return;
      }

      const body = await response.text();
      throw new Error(`Bootstrap failed (${response.status}). body=${body || '<empty>'}`);
    },
    {
      apiBaseURL: args.env.apiBaseURL,
      email: args.env.credentials.email,
      password: args.env.credentials.password,
      tenantSlug: args.env.tenantSlug,
      tenantName: args.env.tenantName
    }
  );
}

async function establishFreshBrowserSession(args: { page: Page; env: AuthRefreshEnv }) {
  await args.page.goto('/login', { waitUntil: 'domcontentloaded' });
  await ensureBootstrapAccountIfNeeded(args);

  const loginResult = await args.page.evaluate(
    async ({ apiBaseURL, email, password, tenantSlug }) => {
      const response = await fetch(`${apiBaseURL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email,
          password,
          ...(tenantSlug ? { tenantSlug } : {})
        })
      });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        body
      };
    },
    {
      apiBaseURL: args.env.apiBaseURL,
      email: args.env.credentials.email,
      password: args.env.credentials.password,
      tenantSlug: args.env.tenantSlug
    }
  );

  if (!loginResult.ok) {
    throw new Error(
      `Auth refresh setup login failed (${loginResult.status}). body=${JSON.stringify(loginResult.body)}`
    );
  }

  const accessToken =
    typeof loginResult.body === 'object' && loginResult.body !== null
      ? (loginResult.body as { accessToken?: string }).accessToken
      : undefined;
  if (!accessToken) {
    throw new Error(`Auth refresh setup login did not return accessToken. body=${JSON.stringify(loginResult.body)}`);
  }

  await args.page.evaluate((token) => {
    window.localStorage.setItem('inventory.accessToken', token);
  }, accessToken);

  await args.page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(args.page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function assertRefreshRecovery(args: {
  page: Page;
  apiBaseURL: string;
  injectedToken: string;
}) {
  const refreshCalls: RefreshCall[] = [];
  const onResponse = (response: PWResponse) => {
    const url = response.url();
    if (!isRefreshEndpoint(url)) return;
    refreshCalls.push({
      url,
      method: response.request().method(),
      status: response.status()
    });
  };
  args.page.on('response', onResponse);

  try {
    await args.page.evaluate((token) => {
      window.localStorage.setItem('inventory.accessToken', token);
    }, args.injectedToken);

    await args.page.reload({ waitUntil: 'domcontentloaded' });
    await expect(args.page).toHaveURL(/\/dashboard$/);

    await expect
      .poll(
        () => refreshCalls.length,
        {
          timeout: 15_000,
          intervals: [300, 600],
          message: `Expected /auth/refresh call after replacing access token. Observed=${JSON.stringify(refreshCalls)}`
        }
      )
      .toBeGreaterThan(0);

    expect(
      refreshCalls.some((call) => call.method === 'POST' && call.status >= 200 && call.status < 300),
      `Expected successful POST /auth/refresh response. Observed=${JSON.stringify(refreshCalls)}`
    ).toBeTruthy();

    const refreshedToken = await args.page.evaluate(() => window.localStorage.getItem('inventory.accessToken'));
    expect(refreshedToken).toBeTruthy();
    expect(refreshedToken).not.toBe(args.injectedToken);

    const meResult = await args.page.evaluate(async ({ apiBaseURL }) => {
      const token = window.localStorage.getItem('inventory.accessToken');
      if (!token) return { ok: false, status: 0, error: 'missing token' };
      try {
        const response = await fetch(`${apiBaseURL}/auth/me`, {
          method: 'GET',
          credentials: 'include',
          headers: { Authorization: `Bearer ${token}` }
        });
        return { ok: response.ok, status: response.status, error: '' };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }, { apiBaseURL: args.apiBaseURL });

    expect(
      meResult.ok,
      `Expected /auth/me success after refresh recovery. status=${meResult.status} error=${meResult.error}`
    ).toBe(true);
  } finally {
    args.page.off('response', onResponse);
  }
}

test('@smoke invalid access token is replaced via refresh cookie and session remains authenticated', async ({
  page,
  e2eEnv
}) => {
  await establishFreshBrowserSession({ page, env: e2eEnv });

  await assertRefreshRecovery({
    page,
    apiBaseURL: e2eEnv.apiBaseURL,
    injectedToken: 'e2e.invalid.access.token'
  });
});

test('@smoke expired access token triggers refresh and session remains authenticated', async ({
  page,
  authMeta,
  e2eEnv
}) => {
  const jwtSecret = process.env.JWT_SECRET?.trim() ?? '';
  test.skip(!jwtSecret, 'JWT_SECRET is required to mint expired access token for this test.');

  await establishFreshBrowserSession({ page, env: e2eEnv });

  const expiredToken = mintExpiredAccessToken({
    jwtSecret,
    userId: authMeta.user.id,
    tenantId: authMeta.tenant.id,
    role: authMeta.role ?? 'admin'
  });

  await assertRefreshRecovery({
    page,
    apiBaseURL: e2eEnv.apiBaseURL,
    injectedToken: expiredToken
  });
});
