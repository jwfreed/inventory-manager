import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const PICKING_SERVICE = path.resolve(process.cwd(), 'src/services/picking.service.ts');

test('createWave only plans picks from allocated reservations with tenant scoping', async () => {
  const source = await readFile(PICKING_SERVICE, 'utf8');
  const createWaveIndex = source.indexOf('export async function createWave');
  assert.notEqual(createWaveIndex, -1, 'createWave must exist');
  const body = source.slice(createWaveIndex, source.indexOf('export async function listPickTasks', createWaveIndex));

  assert.match(body, /r\.status = 'ALLOCATED'/, 'createWave must plan only allocated reservations');
  assert.match(body, /r\.tenant_id = \$2/, 'createWave must filter reservation rows by tenant');
  assert.match(body, /sol\.tenant_id = \$2/, 'createWave must filter sales order lines by tenant');
});
