import type { PoolClient } from 'pg';
import { getItem } from './masterData.service';
import { convertToCanonical } from './uomCanonical.service';
import { roundQuantity, toNumber } from '../lib/numbers';
import { deriveWorkOrderStageRouting } from './stageRouting.service';

type WorkOrderInvariantRow = {
  id: string;
  kind: string;
  bom_id: string | null;
  output_item_id: string;
  output_uom: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
  quantity_scrapped: string | number | null;
  default_consume_location_id: string | null;
  default_produce_location_id: string | null;
  produce_to_location_id_snapshot: string | null;
};

type MovementLineInput = {
  itemId: string;
  locationId: string;
  uom: string;
  quantity: number;
  reasonCode?: string | null;
};

type StructuredDomainError = Error & {
  code?: string;
  details?: Record<string, unknown>;
};

function structuredError(code: string, details?: Record<string, unknown>): StructuredDomainError {
  const error = new Error(code) as StructuredDomainError;
  error.code = code;
  error.details = details;
  return error;
}

function sortScopeKey(itemId: string, uom: string) {
  return `${itemId}:${uom}`;
}

export async function assertItemSellableInvariant(tenantId: string, itemId: string) {
  const item = await getItem(tenantId, itemId);
  if (item?.type === 'wip') {
    throw structuredError('WIP_NOT_SELLABLE', {
      itemId,
      sku: item.sku,
      name: item.name
    });
  }
}

export async function assertWorkOrderExecutionInvariants(params: {
  tenantId: string;
  workOrder: WorkOrderInvariantRow;
  consumeLines: MovementLineInput[];
  produceLines: MovementLineInput[];
  client?: PoolClient;
}) {
  const { tenantId, workOrder, consumeLines, produceLines, client } = params;
  const routing = await deriveWorkOrderStageRouting(
    tenantId,
    {
      kind: workOrder.kind,
      outputItemId: workOrder.output_item_id,
      bomId: workOrder.bom_id,
      defaultConsumeLocationId: workOrder.default_consume_location_id,
      defaultProduceLocationId: workOrder.default_produce_location_id,
      produceToLocationIdSnapshot: workOrder.produce_to_location_id_snapshot
    },
    client
  );

  for (const line of consumeLines) {
    const item = await getItem(tenantId, line.itemId);
    if (item?.type === 'wip' && routing.stageType !== 'boxing') {
      throw structuredError('WO_WIP_DOWNSTREAM_STAGE_REQUIRED', {
        workOrderId: workOrder.id,
        stageType: routing.stageType,
        itemId: line.itemId,
        sku: item.sku
      });
    }
  }

  const outputItem = await getItem(tenantId, workOrder.output_item_id);
  if (routing.stageType === 'wrapped_bar' && outputItem?.type === 'finished') {
    throw structuredError('WO_WRAPPED_STAGE_OUTPUT_INVALID', {
      workOrderId: workOrder.id,
      outputItemId: workOrder.output_item_id
    });
  }
  if (routing.stageType === 'boxing' && outputItem?.type === 'wip') {
    throw structuredError('WO_BOXING_STAGE_OUTPUT_INVALID', {
      workOrderId: workOrder.id,
      outputItemId: workOrder.output_item_id
    });
  }

  if (workOrder.kind === 'production' && workOrder.bom_id) {
    const producedTotal = produceLines.reduce((sum, line) => sum + line.quantity, 0);
    if (producedTotal > 0) {
      const { getWorkOrderRequirements } = await import('./workOrders.service');
      const requirements = await getWorkOrderRequirements(tenantId, workOrder.id, producedTotal);
      if (requirements) {
        const expected = new Map<string, number>();
        for (const line of requirements.lines) {
          const key = sortScopeKey(line.componentItemId, line.uom);
          expected.set(key, roundQuantity((expected.get(key) ?? 0) + line.quantityRequired));
        }

        const actual = new Map<string, { quantity: number; hasOverride: boolean }>();
        for (const line of consumeLines) {
          const canonical = await convertToCanonical(tenantId, line.itemId, line.quantity, line.uom, client);
          const key = sortScopeKey(line.itemId, canonical.canonicalUom);
          const existing = actual.get(key);
          const nextQuantity = roundQuantity((existing?.quantity ?? 0) + canonical.quantity);
          const hasOverride = existing?.hasOverride || String(line.reasonCode ?? '').includes('override');
          actual.set(key, { quantity: nextQuantity, hasOverride });
        }

        const expectedKeys = new Set([...expected.keys(), ...actual.keys()]);
        for (const key of expectedKeys) {
          const expectedQty = roundQuantity(expected.get(key) ?? 0);
          const actualEntry = actual.get(key);
          const actualQty = roundQuantity(actualEntry?.quantity ?? 0);
          if (Math.abs(expectedQty - actualQty) > 1e-6 && !actualEntry?.hasOverride) {
            throw structuredError('WO_BOM_EXECUTION_VARIANCE_UNAPPROVED', {
              workOrderId: workOrder.id,
              componentKey: key,
              expectedQty,
              actualQty
            });
          }
        }
      }
    }
  }

  if (workOrder.kind === 'disassembly') {
    const { getDisassemblyPlan } = await import('./disassembly.service');
    const consumeQty = consumeLines.reduce((sum, line) => sum + line.quantity, 0);
    const plan = await getDisassemblyPlan(tenantId, workOrder.id, consumeQty, client);
    if (plan) {
      const expected = new Map<string, number>();
      for (const line of plan.outputs) {
        expected.set(sortScopeKey(line.componentItemId, line.uom), roundQuantity(line.quantityProduced));
      }
      const actual = new Map<string, number>();
      for (const line of produceLines) {
        const canonical = await convertToCanonical(tenantId, line.itemId, line.quantity, line.uom, client);
        const key = sortScopeKey(line.itemId, canonical.canonicalUom);
        actual.set(key, roundQuantity((actual.get(key) ?? 0) + canonical.quantity));
      }
      const allKeys = new Set([...expected.keys(), ...actual.keys()]);
      for (const key of allKeys) {
        const expectedQty = roundQuantity(expected.get(key) ?? 0);
        const actualQty = roundQuantity(actual.get(key) ?? 0);
        if (Math.abs(expectedQty - actualQty) > 1e-6) {
          throw structuredError('WO_DISASSEMBLY_OUTPUT_VARIANCE', {
            workOrderId: workOrder.id,
            componentKey: key,
            expectedQty,
            actualQty
          });
        }
      }
    }
  }
}
