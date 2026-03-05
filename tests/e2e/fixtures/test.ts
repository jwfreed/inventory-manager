import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test as base } from '@playwright/test';
import { E2EApiClient } from './apiClient';
import { cleanupCustomersBestEffort } from './db';
import { loadE2EEnv, type E2EEnv } from './env';

type AuthMeta = {
  accessToken: string;
  user: { id: string; email: string };
  tenant: { id: string; slug: string; name: string };
  role: string | null;
  generatedAt: string;
};

type E2EFixtures = {
  runId: string;
  e2eEnv: E2EEnv;
  authMeta: AuthMeta;
  api: E2EApiClient;
};

const authMetaPath = path.resolve(process.cwd(), 'playwright/.auth/meta.json');
const runNonce =
  process.env.E2E_RUN_ID?.trim() ||
  new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

export const test = base.extend<E2EFixtures>({
  // Playwright custom fixture signature requires object destructuring here.
  // eslint-disable-next-line no-empty-pattern
  runId: async ({}, use, testInfo) => {
    const id = `${runNonce}-w${testInfo.workerIndex}-${shortHash(testInfo.testId)}`;
    await use(id);
  },

  // eslint-disable-next-line no-empty-pattern
  e2eEnv: async ({}, use) => {
    await use(loadE2EEnv());
  },

  // eslint-disable-next-line no-empty-pattern
  authMeta: async ({}, use) => {
    const raw = await readFile(authMetaPath, 'utf8').catch(() => {
      throw new Error(
        [
          `Missing ${authMetaPath}.`,
          'Run `npm run e2e:setup` after starting API/UI to generate auth storage and metadata.'
        ].join(' ')
      );
    });

    const parsed = JSON.parse(raw) as Partial<AuthMeta>;
    if (!parsed.accessToken || !parsed.user?.id || !parsed.tenant?.id) {
      throw new Error(`Invalid auth metadata in ${authMetaPath}. Regenerate via npm run e2e:setup.`);
    }

    await use(parsed as AuthMeta);
  },

  api: async ({ authMeta, runId, e2eEnv }, use) => {
    const client = await E2EApiClient.create({
      apiBaseURL: e2eEnv.apiBaseURL,
      accessToken: authMeta.accessToken,
      runId
    });
    try {
      await use(client);
    } finally {
      await client.dispose();
    }
  }
});

test.afterEach(async ({ authMeta, runId, e2eEnv }, testInfo) => {
  if (!e2eEnv.dbCleanup) return;
  try {
    await cleanupCustomersBestEffort({
      tenantId: authMeta.tenant.id,
      runId
    });
  } catch (error) {
    testInfo.annotations.push({
      type: 'warning',
      description: `Best-effort customer cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    });
  }
});

export { expect };
