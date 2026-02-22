import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

async function waitForHealth(baseUrl, expected, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (expected && res.status === 200) return;
      if (!expected && res.status !== 200) return;
    } catch {
      if (!expected) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`expected health=${expected} for ${baseUrl}`);
}

test('test harness startup is explicit about repair mode', async () => {
  const filePath = path.resolve(process.cwd(), 'tests/api/helpers/testServer.mjs');
  const source = await readFile(filePath, 'utf8');

  assert.match(source, /--repair-defaults/);
  assert.match(source, /WAREHOUSE_DEFAULTS_REPAIR:\s*process\.env\.WAREHOUSE_DEFAULTS_REPAIR\s*\?\?\s*'true'/);
});

test('test harness server lifecycle can start and stop twice without leaking process/port', async () => {
  const port = 3110 + Math.floor(Math.random() * 200);
  const baseUrl = `http://127.0.0.1:${port}`;
  const previousTestBase = process.env.TEST_BASE_URL;
  const previousApiBase = process.env.API_BASE_URL;
  const previousTestTenant = process.env.TEST_TENANT_ID;

  process.env.TEST_BASE_URL = baseUrl;
  process.env.TEST_TENANT_ID = randomUUID();
  delete process.env.API_BASE_URL;

  const helperPath = path.resolve(process.cwd(), 'tests/api/helpers/testServer.mjs');
  const helperUrl = `${pathToFileURL(helperPath).href}?run=${Date.now()}_${Math.random()}`;
  const { ensureTestServer, stopTestServer, getBaseUrl } = await import(helperUrl);

  try {
    assert.equal(getBaseUrl(), baseUrl);

    await ensureTestServer();
    await waitForHealth(baseUrl, true);
    await stopTestServer();
    await waitForHealth(baseUrl, false);

    await ensureTestServer();
    await waitForHealth(baseUrl, true);
    await stopTestServer();
    await waitForHealth(baseUrl, false);
  } finally {
    await stopTestServer();
    if (previousTestBase === undefined) {
      delete process.env.TEST_BASE_URL;
    } else {
      process.env.TEST_BASE_URL = previousTestBase;
    }
    if (previousApiBase === undefined) {
      delete process.env.API_BASE_URL;
    } else {
      process.env.API_BASE_URL = previousApiBase;
    }
    if (previousTestTenant === undefined) {
      delete process.env.TEST_TENANT_ID;
    } else {
      process.env.TEST_TENANT_ID = previousTestTenant;
    }
  }
});
