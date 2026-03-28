import 'dotenv/config';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const tier = args[0];
const flags = new Set(args.slice(1));

if (!tier) {
  console.error('Usage: node scripts/run-test-tier.mjs <truth|fixtures|contracts|scenarios> [--list]');
  process.exit(1);
}

const manifestPath = path.resolve(ROOT, 'tests', tier, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const files = collectFiles(manifest);

if (files.length === 0) {
  console.error(`TEST_TIER_EMPTY ${tier} has no files`);
  process.exit(1);
}

if (flags.has('--list')) {
  for (const file of files) {
    console.log(file);
  }
  process.exit(0);
}

const testArgs = ['--test', '--test-reporter=spec'];
if (manifest.timeoutMs) {
  testArgs.push(`--test-timeout=${manifest.timeoutMs}`);
}
if (manifest.concurrency) {
  testArgs.push(`--test-concurrency=${manifest.concurrency}`);
}
if (manifest.useSetupImport !== false) {
  testArgs.push('--import', './tests/setup.mjs');
}
testArgs.push(...files);

const childEnv = await buildChildEnv(process.env);
const result = spawnSync(process.execPath, testArgs, {
  cwd: ROOT,
  stdio: 'inherit',
  env: childEnv
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);

function collectFiles(manifest) {
  const explicitFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const directories = Array.isArray(manifest.directories) ? manifest.directories : [];
  const excludeFiles = new Set(Array.isArray(manifest.excludeFiles) ? manifest.excludeFiles : []);
  const candidates = new Set();

  for (const file of explicitFiles) {
    candidates.add(normalize(file));
  }

  for (const directory of directories) {
    walkDirectory(path.resolve(ROOT, directory), candidates);
  }

  return Array.from(candidates)
    .filter((file) => !excludeFiles.has(file))
    .sort();
}

function walkDirectory(directoryPath, acc) {
  for (const entry of readdirSync(directoryPath)) {
    const fullPath = path.join(directoryPath, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walkDirectory(fullPath, acc);
      continue;
    }
    if (!entry.endsWith('.test.mjs')) continue;
    acc.add(normalize(path.relative(ROOT, fullPath)));
  }
}

function normalize(value) {
  return String(value).replace(/\\/g, '/');
}

async function buildChildEnv(env) {
  const databaseEnv = normalizeDatabaseEnv(env);
  const explicitTestBaseUrl = normalizeBaseUrl(env.TEST_BASE_URL);
  const explicitApiBaseUrl = normalizeBaseUrl(env.API_BASE_URL);

  if (explicitTestBaseUrl && explicitApiBaseUrl) {
    return { ...env, ...databaseEnv, TEST_BASE_URL: explicitTestBaseUrl, API_BASE_URL: explicitApiBaseUrl };
  }
  if (explicitTestBaseUrl) {
    return { ...env, ...databaseEnv, TEST_BASE_URL: explicitTestBaseUrl, API_BASE_URL: explicitTestBaseUrl };
  }
  if (explicitApiBaseUrl) {
    return { ...env, ...databaseEnv, TEST_BASE_URL: explicitApiBaseUrl, API_BASE_URL: explicitApiBaseUrl };
  }

  // Tier runs must not attach to an arbitrary dev server already bound to 3000.
  const isolatedBaseUrl = `http://127.0.0.1:${await reserveEphemeralPort()}`;
  return { ...env, ...databaseEnv, TEST_BASE_URL: isolatedBaseUrl, API_BASE_URL: isolatedBaseUrl };
}

function normalizeBaseUrl(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/$/, '');
}

function normalizeDatabaseEnv(env) {
  const canonicalDatabaseUrl = String(env.TEST_DATABASE_URL ?? env.DATABASE_URL ?? '').trim();
  if (!canonicalDatabaseUrl) {
    throw new Error(
      'TEST_TIER_DATABASE_URL_MISSING: set TEST_DATABASE_URL or DATABASE_URL before running tier tests.'
    );
  }
  return {
    TEST_DATABASE_URL: canonicalDatabaseUrl,
    DATABASE_URL: canonicalDatabaseUrl
  };
}

function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        if (!port) {
          reject(new Error('TEST_TIER_PORT_RESOLUTION_FAILED'));
          return;
        }
        resolve(port);
      });
    });
  });
}
