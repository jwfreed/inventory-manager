import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildBomGraph, validateBomDataset } from '../../scripts/seed/siamaya/generate_simulation_assets.mjs';

test('siamaya BOM validator passes the checked-in normalized BOM', async () => {
  const bomDocument = JSON.parse(
    await readFile(new URL('../../scripts/seed/siamaya/siamaya-bom-production.json', import.meta.url), 'utf8')
  );
  const report = validateBomDataset(bomDocument, buildBomGraph(bomDocument));

  assert.equal(report.valid, true);
  assert.equal(report.summary.cycleCount, 0);
  assert.equal(report.summary.selfReferenceCount, 0);
  assert.equal(report.summary.duplicateComponentCount, 0);
  assert.equal(report.summary.invalidQuantityCount, 0);
  assert.equal(report.summary.uomMismatchCount, 0);
  assert.equal(report.summary.yieldInconsistencyCount, 0);
});

test('siamaya BOM validator detects structural faults in a malformed fixture', () => {
  const malformed = {
    schemaVersion: 1,
    sourceFile: 'synthetic.json',
    rows: [
      { 'Finished Product': 'A', 'Output Qty': 1, 'Output UOM': 'piece', 'Component Item': 'A', 'Component Qty': 1, 'Component UOM': 'piece' },
      { 'Finished Product': 'B', 'Output Qty': 1, 'Output UOM': 'piece', 'Component Item': 'C', 'Component Qty': 1, 'Component UOM': 'piece' },
      { 'Finished Product': 'B', 'Output Qty': 1, 'Output UOM': 'piece', 'Component Item': 'C', 'Component Qty': 2, 'Component UOM': 'piece' },
      { 'Finished Product': 'D', 'Output Qty': 0, 'Output UOM': 'piece', 'Component Item': 'E', 'Component Qty': 1, 'Component UOM': 'piece' },
      { 'Finished Product': 'F', 'Output Qty': 1, 'Output UOM': 'piece', 'Component Item': 'G', 'Component Qty': 0, 'Component UOM': 'piece' },
      { 'Finished Product': 'H', 'Output Qty': 1, 'Output UOM': 'piece', 'Component Item': 'I', 'Component Qty': 1, 'Component UOM': 'piece' },
      { 'Finished Product': 'I', 'Output Qty': 1, 'Output UOM': 'piece', 'Component Item': 'H', 'Component Qty': 1, 'Component UOM': 'piece' },
      { 'Finished Product': 'J', 'Output Qty': 1, 'Output UOM': 'piece', 'Component Item': 'K', 'Component Qty': 1, 'Component UOM': 'g' },
      { 'Finished Product': 'K', 'Output Qty': 1, 'Output UOM': 'piece', 'Component Item': 'L', 'Component Qty': 1, 'Component UOM': 'piece' },
      { 'Finished Product': 'M', 'Output Qty': 2, 'Output UOM': 'piece', 'Component Item': 'N', 'Component Qty': 1, 'Component UOM': 'piece' },
      { 'Finished Product': 'M', 'Output Qty': 3, 'Output UOM': 'piece', 'Component Item': 'O', 'Component Qty': 1, 'Component UOM': 'piece' }
    ]
  };

  const report = validateBomDataset(malformed, buildBomGraph(malformed));

  assert.equal(report.valid, false);
  assert.ok(report.summary.cycleCount > 0);
  assert.ok(report.summary.selfReferenceCount > 0);
  assert.ok(report.summary.duplicateComponentCount > 0);
  assert.ok(report.summary.invalidQuantityCount > 0);
  assert.ok(report.summary.uomMismatchCount > 0);
  assert.ok(report.summary.yieldInconsistencyCount > 0);
});
