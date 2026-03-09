import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerProofFixture } from './helpers/ledgerProofFixture.mjs';

test('ledger replay audit recomputes hashes and validates persisted event identity for every row', async () => {
  const { harness } = await createLedgerProofFixture('truth-ledger-replay');

  const audit = await harness.auditReplayDeterminism(10);
  assert.ok(audit.movementAudit.totalMovements > 0);
  assert.equal(audit.movementAudit.rowsMissingDeterministicHash, 0);
  assert.equal(audit.movementAudit.postCutoffRowsMissingHash, 0);
  assert.equal(audit.movementAudit.replayIntegrityFailures.count, 0);
  assert.equal(audit.eventRegistryFailures.count, 0);
});
