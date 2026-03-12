import {
  buildBomGraph,
  generateSimulationAssets,
  renderSimulationAssetFiles,
  validateBomDataset,
  writeSimulationAssets
} from './focused_75g_assets.mjs';

export {
  buildBomGraph,
  generateSimulationAssets,
  renderSimulationAssetFiles,
  validateBomDataset,
  writeSimulationAssets
};

function main() {
  const write = process.argv.includes('--write');
  const assets = write ? writeSimulationAssets() : generateSimulationAssets();
  const summary = {
    generatedAt: assets.validationDocument.generatedAt,
    finishedSkuCount: assets.scoped75gFinishedSkus.length,
    minimalStockItems: assets.minimalStockProfile.items.length,
    baseStockItems: assets.baseStockProfile.items.length,
    coverageTargetMet: assets.validationDocument.finishedGoodsCoverage.meetsTarget,
    simulationsSucceeded: assets.validationDocument.simulationsSucceeded
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
