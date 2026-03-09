import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const INVENTORY_COMMAND_WRAPPER = path.resolve(process.cwd(), 'src/modules/platform/application/runInventoryCommand.ts');

test('runInventoryCommand appends authoritative events before projection operations', async () => {
  const source = await readFile(INVENTORY_COMMAND_WRAPPER, 'utf8');
  const appendIndex = source.indexOf('appendInventoryEventsWithDispatch(');
  const projectionIndex = source.indexOf('for (const projectionOp of execution.projectionOps ?? [])');

  assert.notEqual(appendIndex, -1);
  assert.notEqual(projectionIndex, -1);
  assert.ok(appendIndex < projectionIndex);
});
