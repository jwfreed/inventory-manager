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

const baseUrl = (process.env.TEST_BASE_URL || process.env.API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const parsedBaseUrl = new URL(baseUrl);
const basePort = parsedBaseUrl.port || (parsedBaseUrl.protocol === 'https:' ? '443' : '80');
if (!process.env.TEST_BASE_URL) {
  process.env.TEST_BASE_URL = baseUrl;
}
if (!process.env.API_BASE_URL) {
  process.env.API_BASE_URL = baseUrl;
}

let startPromise;
let startedByUs = false;
let child;
let logStream;
let processHooksInstalled = false;
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function resolveSpawnDatabaseUrl() {
  const databaseUrl = (process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '').trim();
  if (!databaseUrl) {
    throw new Error(
      'TEST_SERVER_DATABASE_URL_MISSING: set TEST_DATABASE_URL (preferred) or DATABASE_URL before running ops/api tests.'
    );
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('TEST_SERVER_DATABASE_URL_INVALID: resolved database URL is not a valid URL.');
  }

  if (process.env.CI) {
    const host = parsed.hostname.toLowerCase();
    if (LOCAL_DB_HOSTS.has(host)) {
      throw new Error(
        `TEST_SERVER_DATABASE_URL_INVALID_FOR_CI: CI cannot use localhost Postgres (${host}). Set TEST_DATABASE_URL to your Postgres service hostname.`
      );
    }
  }
  return databaseUrl;
}

function splitNodeOptions(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  return text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

function stripWrappingQuotes(value) {
  const text = String(value ?? '');
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function isPermissionModelOption(option) {
  const normalized = stripWrappingQuotes(option).trim();
  return (
    normalized === '--experimental-permission'
    || normalized === '--permission'
    || normalized.startsWith('--allow-')
    || normalized.startsWith('--deny-')
  );
}

function sanitizeChildNodeOptions(nodeOptions) {
  const tokens = splitNodeOptions(nodeOptions);
  if (tokens.length === 0) return { value: '', removed: [] };
  const removed = [];
  const kept = [];
  for (const token of tokens) {
    if (isPermissionModelOption(token)) {
      removed.push(stripWrappingQuotes(token));
      continue;
    }
    kept.push(token);
  }
  return { value: kept.join(' ').trim(), removed };
}

function getBaseUrl() {
  return baseUrl;
}

function handleProcessExit() {
  if (startedByUs && child) {
    child.kill('SIGTERM');
  }
}

async function handleProcessSigint() {
  await stopTestServer();
  process.exit(1);
}

function installProcessHooks() {
  if (processHooksInstalled) return;
  process.on('exit', handleProcessExit);
  process.on('SIGINT', handleProcessSigint);
  processHooksInstalled = true;
}

function uninstallProcessHooks() {
  if (!processHooksInstalled) return;
  process.off('exit', handleProcessExit);
  process.off('SIGINT', handleProcessSigint);
  processHooksInstalled = false;
}

function destroyChildStream(stream, destination) {
  if (!stream) return;
  try {
    if (typeof stream.unpipe === 'function') {
      stream.unpipe(destination);
    }
  } catch {
    // no-op
  }
  try {
    stream.removeAllListeners();
  } catch {
    // no-op
  }
  if (typeof stream.destroy === 'function' && stream.destroyed !== true) {
    stream.destroy();
  }
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
    installProcessHooks();
    const logPath = path.resolve(process.cwd(), 'server.log');
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const testTenantScope =
      process.env.TEST_TENANT_ID?.trim()
      || process.env.WAREHOUSE_DEFAULTS_TENANT_ID?.trim()
      || '';
    const databaseUrl = resolveSpawnDatabaseUrl();
    const sanitizedNodeOptions = sanitizeChildNodeOptions(process.env.NODE_OPTIONS);
    if (sanitizedNodeOptions.removed.length > 0) {
      console.warn('[test.server] stripped Node permission flags for spawned API process', {
        removed: sanitizedNodeOptions.removed
      });
    }
    child = spawn(
      'node',
      ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', 'src/server.ts', '--repair-defaults'],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          NODE_OPTIONS: sanitizedNodeOptions.value,
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
    if (typeof child.unref === 'function') {
      child.unref();
    }
    if (typeof child.stdout?.unref === 'function') {
      child.stdout.unref();
    }
    if (typeof child.stderr?.unref === 'function') {
      child.stderr.unref();
    }
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
  const activeChild = child;
  child = undefined;
  startedByUs = false;
  if (activeChild) {
    const waitForClose = new Promise((resolve) => {
      let settled = false;
      const finalize = () => {
        if (settled) return;
        settled = true;
        resolve(undefined);
      };
      activeChild.once('close', finalize);
      activeChild.once('error', finalize);
    });

    activeChild.kill('SIGTERM');
    let gracefulTimer;
    const gracefulTimeout = new Promise((resolve) => {
      gracefulTimer = setTimeout(() => resolve(false), 4000);
    });
    const graceful = await Promise.race([
      waitForClose.then(() => true),
      gracefulTimeout
    ]);
    clearTimeout(gracefulTimer);
    if (!graceful) {
      activeChild.kill('SIGKILL');
      let forcedTimer;
      const forcedTimeout = new Promise((resolve) => {
        forcedTimer = setTimeout(resolve, 2000);
      });
      await Promise.race([
        waitForClose,
        forcedTimeout
      ]);
      clearTimeout(forcedTimer);
    }
    destroyChildStream(activeChild.stdout, logStream);
    destroyChildStream(activeChild.stderr, logStream);
    destroyChildStream(activeChild.stdin, null);
    activeChild.removeAllListeners();
  }
  if (logStream) {
    await new Promise((resolve) => logStream.end(resolve));
    logStream = undefined;
  }
  uninstallProcessHooks();
}

export { ensureTestServer, stopTestServer, getBaseUrl };
