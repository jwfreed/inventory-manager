import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.resolve(process.cwd(), relativePath), 'utf8'));
}

test('package scripts expose truth/contracts/scenarios tier entrypoints', async () => {
  const packageJson = await loadJson('package.json');
  const scripts = packageJson.scripts ?? {};

  assert.match(String(scripts['test:truth'] ?? ''), /scripts\/run-test-tier\.mjs truth/);
  assert.match(String(scripts['test:contracts'] ?? ''), /scripts\/run-test-tier\.mjs contracts/);
  assert.match(String(scripts['test:scenarios'] ?? ''), /scripts\/run-test-tier\.mjs scenarios/);
});

test('test tier manifests exist under tests/truth, tests/contracts, and tests/scenarios', async () => {
  for (const relativePath of [
    'tests/truth/manifest.json',
    'tests/contracts/manifest.json',
    'tests/scenarios/manifest.json'
  ]) {
    const fileStat = await stat(path.resolve(process.cwd(), relativePath));
    assert.equal(fileStat.isFile(), true, `${relativePath} must exist`);
  }

  const truthManifest = await loadJson('tests/truth/manifest.json');
  const contractsManifest = await loadJson('tests/contracts/manifest.json');
  const scenariosManifest = await loadJson('tests/scenarios/manifest.json');

  assert.ok(Array.isArray(truthManifest.files) && truthManifest.files.length > 0, 'truth manifest must pin invariant files');
  assert.ok(Array.isArray(contractsManifest.files) && contractsManifest.files.length > 0, 'contracts manifest must pin contract files');
  assert.ok(Array.isArray(scenariosManifest.directories) && scenariosManifest.directories.length > 0, 'scenarios manifest must define heavy workflow directories');
});

test('GitHub Actions routes PRs to truth, pushes to contracts, and nightly to scenarios', async () => {
  const ciWorkflow = await readFile(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  const nightlyWorkflow = await readFile(path.resolve(process.cwd(), '.github/workflows/ak47.yml'), 'utf8');
  const playwrightWorkflow = await readFile(path.resolve(process.cwd(), '.github/workflows/playwright.yml'), 'utf8');

  assert.match(ciWorkflow, /pull_request:/);
  assert.match(ciWorkflow, /push:/);
  assert.match(ciWorkflow, /npm run test:truth/);
  assert.match(ciWorkflow, /npm run test:contracts/);
  assert.doesNotMatch(ciWorkflow, /npm run test:scenarios/);

  assert.match(nightlyWorkflow, /schedule:/);
  assert.match(nightlyWorkflow, /npm run test:scenarios/);

  assert.doesNotMatch(playwrightWorkflow, /pull_request:/);
  assert.doesNotMatch(playwrightWorkflow, /^on:\s*\n\s*push:/m);
});
