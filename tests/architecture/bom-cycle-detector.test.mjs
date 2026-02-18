import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBomCyclesAtRest } from '../../scripts/lib/bomCycleDetector.mjs';

test('detectBomCyclesAtRest returns deterministic cycle samples', () => {
  const edges = [
    { parent_item_id: 'B', component_item_id: 'C' },
    { parent_item_id: 'A', component_item_id: 'B' },
    { parent_item_id: 'C', component_item_id: 'A' }
  ];
  const result = detectBomCyclesAtRest(edges, { cycleLimit: 10, nodeLimit: 100 });
  assert.equal(result.count, 1);
  assert.deepEqual(result.samplePaths, [['A', 'B', 'C', 'A']]);
});

test('detectBomCyclesAtRest does not report DAG reuse as cycle', () => {
  const edges = [
    { parent_item_id: 'A', component_item_id: 'B' },
    { parent_item_id: 'A', component_item_id: 'C' },
    { parent_item_id: 'B', component_item_id: 'X' },
    { parent_item_id: 'C', component_item_id: 'X' }
  ];
  const result = detectBomCyclesAtRest(edges, { cycleLimit: 10, nodeLimit: 100 });
  assert.equal(result.count, 0);
  assert.deepEqual(result.samplePaths, []);
});
