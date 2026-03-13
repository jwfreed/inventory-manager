import test from 'node:test';
import assert from 'node:assert/strict';

import { generateSimulationAssets } from '../../scripts/seed/siamaya/generate_simulation_assets.mjs';

test('siamaya 75g seed keeps wrapped bars intermediate and boxed bars finished', () => {
  const assets = generateSimulationAssets();

  assert.equal(assets.validationDocument.twoStageProduction.wrappedBarsAreIntermediates, true);
  assert.equal(assets.validationDocument.twoStageProduction.boxedBarsAreFinishedGoods, true);
  assert.equal(assets.validationDocument.sellability.wrappedBarsSellable, false);
  assert.equal(assets.validationDocument.sellability.boxedBarsSellable, true);
  assert.equal(assets.validationDocument.sellability.wrappedBarsShippable, false);
  assert.equal(assets.validationDocument.twoStageProduction.wrappedBarsInOpeningStock.minimal, 0);
  assert.equal(assets.validationDocument.twoStageProduction.wrappedBarsInOpeningStock.base, 0);
  assert.equal(assets.workflowDocument.summary.twoStageFlowRepresented, true);
  assert.equal(assets.workflowDocument.summary.shippingWrappedBarsSuggested, false);

  const wrappedWorkOrders = assets.workOrderDocument.workOrders.filter((workOrder) => workOrder.stage === 'WRAPPED_BAR');
  const boxedWorkOrders = assets.workOrderDocument.workOrders.filter((workOrder) => workOrder.stage === 'BOXED_BAR');
  assert.equal(wrappedWorkOrders.length, assets.boxedFinishedGoods.length);
  assert.equal(boxedWorkOrders.length, assets.boxedFinishedGoods.length);

  for (const workOrder of boxedWorkOrders) {
    assert.ok(
      workOrder.materialRequirements.some((component) => /\s-\sWrapped \(75g\)$/i.test(String(component.itemName))),
      `boxed work order missing wrapped-bar input: ${workOrder.itemName}`
    );
  }
});
