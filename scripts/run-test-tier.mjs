import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const tier = args[0];
const flags = new Set(args.slice(1));

if (!tier) {
  console.error('Usage: node scripts/run-test-tier.mjs <truth|contracts|scenarios> [--list]');
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

const result = spawnSync(process.execPath, testArgs, {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env
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
