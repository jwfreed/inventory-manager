import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const ROOT = process.cwd();
const POLICY = path.resolve(ROOT, 'src/domain/transfers/transferPolicy.ts');
const PLAN = path.resolve(ROOT, 'src/domain/transfers/transferPlan.ts');
const EXECUTION = path.resolve(ROOT, 'src/domain/transfers/transferExecution.ts');
const SERVICE = path.resolve(ROOT, 'src/services/transfers.service.ts');

test('transfer domain hardening keeps the location-level model and clean layer boundaries', async () => {
  const [policySource, planSource, executionSource, serviceSource] = await Promise.all([
    readFile(POLICY, 'utf8'),
    readFile(PLAN, 'utf8'),
    readFile(EXECUTION, 'utf8'),
    readFile(SERVICE, 'utf8')
  ]);

  assert.match(policySource, /TRANSFER_ADDRESSING_MODEL = 'location-level'/);
  assert.match(policySource, /TRANSFER_BIN_POLICY = 'readiness-only'/);

  for (const source of [policySource, planSource, executionSource, serviceSource]) {
    assert.doesNotMatch(source, /\bsourceDefaultBinId\b/);
    assert.doesNotMatch(source, /\bdestinationDefaultBinId\b/);
  }

  assert.doesNotMatch(policySource, /\bpersistInventoryMovement\b/);
  assert.doesNotMatch(policySource, /\bvalidateSufficientStock\b/);
  assert.doesNotMatch(policySource, /\brelocateTransferCostLayersInTx\b/);

  assert.doesNotMatch(planSource, /\bpersistInventoryMovement\b/);
  assert.doesNotMatch(planSource, /\bvalidateSufficientStock\b/);
  assert.doesNotMatch(planSource, /\brelocateTransferCostLayersInTx\b/);

  assert.doesNotMatch(executionSource, /\bresolveWarehouseIdForLocation\b/);
  assert.doesNotMatch(executionSource, /\bassertLocationInventoryReady\b/);
  assert.doesNotMatch(executionSource, /\bgetCanonicalMovementFields\b/);

  assert.doesNotMatch(serviceSource, /\bvalidateSufficientStock\b/);
  assert.doesNotMatch(serviceSource, /\brelocateTransferCostLayersInTx\b/);
});
