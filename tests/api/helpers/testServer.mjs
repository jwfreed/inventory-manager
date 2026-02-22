/**
 * Helper: test server lifecycle
 * Purpose: Start/stop the API server for tests and gate readiness via /healthz.
 * Preconditions: npm run dev available; API_BASE_URL/TEST_BASE_URL configured or defaulted.
 * Postconditions: ensureTestServer resolves only after server is healthy.
 * Consumers: test harness and ensureSession.
 * Common failures: SERVER_STARTUP_TIMEOUT when server fails to boot or port is in use.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const baseUrl = (process.env.TEST_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const parsedBaseUrl = new URL(baseUrl);
const basePort = parsedBaseUrl.port || (parsedBaseUrl.protocol === 'https:' ? '443' : '80');
if (!process.env.API_BASE_URL) {
  process.env.API_BASE_URL = baseUrl;
}

let startPromise;
let startedByUs = false;
let child;
let logStream;

function getBaseUrl() {
  return baseUrl;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function isHealthy() {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/healthz`, 1000);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitForHealthy(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isHealthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function ensureTestServer() {
  if (startPromise) return startPromise;
  startPromise = (async () => {
    if (await isHealthy()) {
      startedByUs = false;
      return;
    }
    startedByUs = true;
    const logPath = path.resolve(process.cwd(), 'server.log');
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const testTenantScope =
      process.env.TEST_TENANT_ID?.trim()
      || process.env.WAREHOUSE_DEFAULTS_TENANT_ID?.trim()
      || '';
    child = spawn(
      'node',
      ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', 'src/server.ts', '--repair-defaults'],
      {
        env: {
          ...process.env,
          PORT: basePort,
          NODE_ENV: 'test',
          // Tests run with explicit repair mode to avoid fixture drift blocking startup.
          WAREHOUSE_DEFAULTS_REPAIR: process.env.WAREHOUSE_DEFAULTS_REPAIR ?? 'true',
          WAREHOUSE_DEFAULTS_TENANT_ID: testTenantScope
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
      }
    );
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    const ready = await waitForHealthy(30000);
    if (!ready) {
      await stopTestServer();
      throw new Error(`SERVER_STARTUP_TIMEOUT baseUrl=${baseUrl} log=${logPath}`);
    }
  })().catch((error) => {
    startPromise = undefined;
    throw error;
  });
  return startPromise;
}

async function stopTestServer() {
  startPromise = undefined;
  if (!startedByUs) return;
  startedByUs = false;
  if (child) {
    child.kill('SIGTERM');
    child = undefined;
  }
  if (logStream) {
    logStream.end();
    logStream = undefined;
  }
}

process.on('exit', () => {
  if (startedByUs && child) {
    child.kill('SIGTERM');
  }
});
process.on('SIGINT', async () => {
  await stopTestServer();
  process.exit(1);
});

export { ensureTestServer, stopTestServer, getBaseUrl };
