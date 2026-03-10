import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  generateSimulationAssets,
  renderSimulationAssetFiles
} from '../../scripts/seed/siamaya/generate_simulation_assets.mjs';

const ROOT = process.cwd();

test('siamaya simulation assets are deterministic, acyclic, and coverage-complete', () => {
  const assets = generateSimulationAssets();
  const rendered = renderSimulationAssetFiles(assets);

  assert.equal(assets.validationDocument.dagAcyclic, true);
  assert.equal(assets.validationDocument.finishedGoodsCoverage.meetsTarget, true);
  assert.equal(assets.validationDocument.simulationsSucceeded, true);

  for (const [filePath, expected] of rendered.entries()) {
    const actual = fs.readFileSync(filePath, 'utf8');
    assert.equal(
      actual,
      expected,
      `generated simulation asset drifted: ${path.relative(ROOT, filePath)}`
    );
  }
});
