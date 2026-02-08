import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const baseUrl = (process.env.TEST_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
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
    child = spawn('npm', ['run', 'dev'], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    const ready = await waitForHealthy(30000);
    if (!ready) {
      await stopTestServer();
      throw new Error(`SERVER_STARTUP_TIMEOUT baseUrl=${baseUrl} log=${logPath}`);
    }
  })();
  return startPromise;
}

async function stopTestServer() {
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
