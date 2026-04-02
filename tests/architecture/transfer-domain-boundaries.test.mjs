import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const ROOT = process.cwd();
const POLICY = path.resolve(ROOT, 'src/domain/transfers/transferPolicy.ts');
const PLAN = path.resolve(ROOT, 'src/domain/transfers/transferPlan.ts');
const EXECUTION = path.resolve(ROOT, 'src/domain/transfers/transferExecution.ts');
const REVERSAL_POLICY = path.resolve(ROOT, 'src/domain/transfers/transferReversalPolicy.ts');
const REVERSAL_PLAN = path.resolve(ROOT, 'src/domain/transfers/transferReversalPlan.ts');
const REVERSAL_EXECUTION = path.resolve(ROOT, 'src/domain/transfers/transferReversalExecution.ts');
const SERVICE = path.resolve(ROOT, 'src/services/transfers.service.ts');

test('transfer domain hardening keeps the location-level model and clean layer boundaries', async () => {
  const [
    policySource,
    planSource,
    executionSource,
    reversalPolicySource,
    reversalPlanSource,
    reversalExecutionSource,
    serviceSource
  ] = await Promise.all([
    readFile(POLICY, 'utf8'),
    readFile(PLAN, 'utf8'),
    readFile(EXECUTION, 'utf8'),
    readFile(REVERSAL_POLICY, 'utf8'),
    readFile(REVERSAL_PLAN, 'utf8'),
    readFile(REVERSAL_EXECUTION, 'utf8'),
    readFile(SERVICE, 'utf8')
  ]);

  assert.match(policySource, /TRANSFER_ADDRESSING_MODEL = 'location-level'/);
  assert.match(policySource, /TRANSFER_BIN_POLICY = 'readiness-only'/);

  for (const source of [
    policySource,
    planSource,
    executionSource,
    reversalPolicySource,
    reversalPlanSource,
    reversalExecutionSource,
    serviceSource
  ]) {
    assert.doesNotMatch(source, /\bsourceDefaultBinId\b/);
    assert.doesNotMatch(source, /\bdestinationDefaultBinId\b/);
  }

  assert.doesNotMatch(policySource, /\bpersistInventoryMovement\b/);
  assert.doesNotMatch(policySource, /\bvalidateSufficientStock\b/);
  assert.doesNotMatch(policySource, /\brelocateTransferCostLayersInTx\b/);
  assert.doesNotMatch(reversalPolicySource, /\bpersistInventoryMovement\b/);
  assert.doesNotMatch(reversalPolicySource, /\bapplyInventoryBalanceDelta\b/);
  assert.doesNotMatch(reversalPolicySource, /\breverseTransferCostLayersInTx\b/);

  assert.doesNotMatch(planSource, /\bpersistInventoryMovement\b/);
  assert.doesNotMatch(planSource, /\bvalidateSufficientStock\b/);
  assert.doesNotMatch(planSource, /\brelocateTransferCostLayersInTx\b/);
  assert.doesNotMatch(reversalPlanSource, /\bpersistInventoryMovement\b/);
  assert.doesNotMatch(reversalPlanSource, /\bapplyInventoryBalanceDelta\b/);
  assert.doesNotMatch(reversalPlanSource, /\breverseTransferCostLayersInTx\b/);

  assert.doesNotMatch(executionSource, /\bresolveWarehouseIdForLocation\b/);
  assert.doesNotMatch(executionSource, /\bassertLocationInventoryReady\b/);
  assert.doesNotMatch(executionSource, /\bgetCanonicalMovementFields\b/);
  assert.doesNotMatch(reversalExecutionSource, /\bresolveWarehouseIdForLocation\b/);
  assert.doesNotMatch(reversalExecutionSource, /\bassertLocationInventoryReady\b/);
  assert.doesNotMatch(reversalExecutionSource, /\bgetCanonicalMovementFields\b/);

  assert.doesNotMatch(serviceSource, /\bvalidateSufficientStock\b/);
  assert.doesNotMatch(serviceSource, /\brelocateTransferCostLayersInTx\b/);
  assert.doesNotMatch(serviceSource, /\breverseTransferCostLayersInTx\b/);
});
