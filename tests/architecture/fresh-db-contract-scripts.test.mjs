import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function loadScripts() {
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  return packageJson?.scripts ?? {};
}

test('migrate runner is canonical and includes post-migrate verification', async () => {
  const scripts = await loadScripts();
  const migrateUp = String(scripts['migrate:up'] ?? '');
  const migrate = String(scripts.migrate ?? '');
  const migrateVerify = String(scripts['migrate:verify'] ?? '');

  assert.match(migrateUp, /\bnode-pg-migrate up\b/);
  assert.match(migrateUp, /--migrations-dir src\/migrations\b/);
  assert.match(migrateUp, /-r dotenv\/config\b/);
  assert.match(migrate, /\bnpm run migrate:verify\b/);
  assert.match(migrateVerify, /scripts\/verify-migration-state\.ts/);
});

test('reset/migrate/seed command is explicitly wired for deterministic fresh DB flow', async () => {
  const scripts = await loadScripts();
  const resetMigrate = String(scripts['db:reset:migrate'] ?? '');
  const resetMigrateSeed = String(scripts['db:reset:migrate:seed'] ?? '');
  const topologySeedDefault = String(scripts['seed:warehouse-topology:default'] ?? '');
  const strictInvariantDefault = String(scripts['invariants:strict:default'] ?? '');

  assert.match(resetMigrate, /\bnpm run migrate\b/);
  assert.match(resetMigrateSeed, /scripts\/db-reset-migrate-seed\.ts/);
  assert.match(topologySeedDefault, /--tenant-id 00000000-0000-0000-0000-000000000001 --fix/);
  assert.match(strictInvariantDefault, /scripts\/inventory_invariants_check\.mjs/);
  assert.match(strictInvariantDefault, /--strict/);
});
