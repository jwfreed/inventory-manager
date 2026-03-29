import type { PoolClient } from 'pg';
import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { convertToCanonical } from './uomCanonical.service';
import { deriveDisassemblyProduceLocation, deriveWorkOrderStageRouting } from './stageRouting.service';
import { fetchBomById, resolveEffectiveBom, type Bom, type BomVersion } from './boms.service';

type WorkOrderRow = {
  id: string;
  status: string;
  kind: string;
  bom_id: string | null;
  bom_version_id: string | null;
  output_item_id: string;
  output_uom: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
  quantity_scrapped: string | number | null;
  default_consume_location_id: string | null;
  default_produce_location_id: string | null;
  produce_to_location_id_snapshot: string | null;
};

export type DisassemblyPlanLine = {
  componentItemId: string;
  componentItemSku: string | null;
  componentItemName: string | null;
  toLocationId: string;
  toLocationCode: string | null;
  toLocationName: string | null;
  toLocationRole: string | null;
  quantityProduced: number;
  uom: string;
};

export type WorkOrderDisassemblyPlan = {
  workOrderId: string;
  status: string;
  bomId: string;
  bomVersionId: string;
  consumeItemId: string;
  consumeItemSku: string | null;
  consumeItemName: string | null;
  consumeLocation: {
    id: string;
    code: string;
    name: string;
    role: string | null;
  } | null;
  quantities: {
    planned: number;
    produced: number;
    scrapped: number;
    remaining: number;
    requestedDisassembly: number;
  };
  outputs: DisassemblyPlanLine[];
};

async function loadWorkOrder(
  tenantId: string,
  workOrderId: string,
  client?: PoolClient
): Promise<WorkOrderRow | null> {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor<WorkOrderRow>(
    `SELECT id,
            status,
            kind,
            bom_id,
            bom_version_id,
            output_item_id,
            output_uom,
            quantity_planned,
            quantity_completed,
            quantity_scrapped,
            default_consume_location_id,
            default_produce_location_id,
            produce_to_location_id_snapshot
       FROM work_orders
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, workOrderId]
  );
  return result.rows[0] ?? null;
}

async function loadItemLabel(
  tenantId: string,
  itemId: string,
  client?: PoolClient
) {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor<{ sku: string | null; name: string | null }>(
    `SELECT sku, name
       FROM items
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, itemId]
  );
  return result.rows[0] ?? { sku: null, name: null };
}

async function resolveWorkOrderBomVersion(
  tenantId: string,
  workOrder: WorkOrderRow,
  client?: PoolClient
): Promise<{ bomId: string; version: BomVersion } | null> {
  const bom = workOrder.bom_id
    ? await fetchBomById(tenantId, workOrder.bom_id, client)
    : await resolveEffectiveBom(tenantId, workOrder.output_item_id, new Date().toISOString());
  if (!bom) {
    return null;
  }
  if (!('versions' in bom)) {
    return {
      bomId: bom.bom.id,
      version: bom.version
    };
  }
  const versionedBom: Bom = bom;
  const version =
    (workOrder.bom_version_id
      ? versionedBom.versions.find(
        (candidate: BomVersion) =>
          candidate.id === workOrder.bom_version_id && candidate.status !== 'retired'
      )
      : null)
    ?? versionedBom.versions.find((candidate: BomVersion) => candidate.status === 'active')
    ?? versionedBom.versions[0];
  if (!version) {
    return null;
  }
  return { bomId: versionedBom.id, version };
}

export async function getDisassemblyPlan(
  tenantId: string,
  workOrderId: string,
  requestedQuantity?: number,
  client?: PoolClient
): Promise<WorkOrderDisassemblyPlan | null> {
  const workOrder = await loadWorkOrder(tenantId, workOrderId, client);
  if (!workOrder) {
    return null;
  }
  if (workOrder.kind !== 'disassembly') {
    throw new Error('WO_DISASSEMBLY_KIND_REQUIRED');
  }

  const planned = roundQuantity(toNumber(workOrder.quantity_planned));
  const produced = roundQuantity(toNumber(workOrder.quantity_completed ?? 0));
  const scrapped = roundQuantity(toNumber(workOrder.quantity_scrapped ?? 0));
  const remaining = roundQuantity(Math.max(0, planned - produced - scrapped));
  const disassemblyQty = roundQuantity(requestedQuantity ?? (remaining > 0 ? remaining : planned));

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
  const consumeItem = await loadItemLabel(tenantId, workOrder.output_item_id, client);
  const bomVersion = await resolveWorkOrderBomVersion(tenantId, workOrder, client);
  if (!bomVersion) {
    throw new Error('WO_BOM_VERSION_NOT_FOUND');
  }

  const normalizedRequested = await convertToCanonical(
    tenantId,
    workOrder.output_item_id,
    disassemblyQty,
    workOrder.output_uom,
    client
  );
  const normalizedYield = await convertToCanonical(
    tenantId,
    workOrder.output_item_id,
    bomVersion.version.yieldQuantity,
    bomVersion.version.yieldUom,
    client
  );
  if (normalizedYield.quantity <= 0) {
    throw new Error('WO_REQUIREMENTS_INVALID_YIELD');
  }
  const factor = normalizedRequested.quantity / (normalizedYield.quantity * (bomVersion.version.yieldFactor ?? 1));

  const outputs: DisassemblyPlanLine[] = [];
  for (const component of bomVersion.version.components) {
    if (component.quantityPerCanonical == null || !component.uomCanonical) {
      throw new Error('WO_BOM_LEGACY_UNSUPPORTED');
    }
    const produceLocation = await deriveDisassemblyProduceLocation(
      tenantId,
      {
        kind: workOrder.kind,
        outputItemId: workOrder.output_item_id,
        bomId: bomVersion.bomId,
        defaultConsumeLocationId: workOrder.default_consume_location_id,
        defaultProduceLocationId: workOrder.default_produce_location_id,
        produceToLocationIdSnapshot: workOrder.produce_to_location_id_snapshot
      },
      { componentItemId: component.componentItemId },
      client
    );
    if (!produceLocation) {
      throw new Error('WO_DISASSEMBLY_OUTPUT_LOCATION_REQUIRED');
    }
    const itemLabel = await loadItemLabel(tenantId, component.componentItemId, client);
    outputs.push({
      componentItemId: component.componentItemId,
      componentItemSku: itemLabel.sku,
      componentItemName: itemLabel.name,
      toLocationId: produceLocation.id,
      toLocationCode: produceLocation.code,
      toLocationName: produceLocation.name,
      toLocationRole: produceLocation.role,
      quantityProduced: roundQuantity(component.quantityPerCanonical * factor),
      uom: component.uomCanonical
    });
  }

  return {
    workOrderId,
    status: workOrder.status,
    bomId: bomVersion.bomId,
    bomVersionId: bomVersion.version.id,
    consumeItemId: workOrder.output_item_id,
    consumeItemSku: consumeItem.sku,
    consumeItemName: consumeItem.name,
    consumeLocation: routing.defaultConsumeLocation
      ? {
          id: routing.defaultConsumeLocation.id,
          code: routing.defaultConsumeLocation.code,
          name: routing.defaultConsumeLocation.name,
          role: routing.defaultConsumeLocation.role
        }
      : null,
    quantities: {
      planned,
      produced,
      scrapped,
      remaining,
      requestedDisassembly: disassemblyQty
    },
    outputs: outputs.filter((line) => line.quantityProduced > 0)
  };
}

export async function executeDisassemblyWorkOrder(
  tenantId: string,
  workOrderId: string,
  params: {
    quantity?: number;
    occurredAt: string;
    notes?: string | null;
    idempotencyKey?: string | null;
  },
  context: { actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null } } = {}
) {
  const plan = await getDisassemblyPlan(tenantId, workOrderId, params.quantity);
  if (!plan) {
    throw new Error('WO_NOT_FOUND');
  }
  if (!plan.consumeLocation) {
    throw new Error('WO_DISASSEMBLY_INPUT_LOCATION_REQUIRED');
  }
  const { recordWorkOrderBatch } = await import('./workOrderExecution.service');
  return recordWorkOrderBatch(
    tenantId,
    workOrderId,
    {
      occurredAt: params.occurredAt,
      notes: params.notes ?? undefined,
      consumeLines: [
        {
          componentItemId: plan.consumeItemId,
          fromLocationId: plan.consumeLocation.id,
          uom: 'each',
          quantity: plan.quantities.requestedDisassembly,
          reasonCode: 'disassembly_issue'
        }
      ],
      produceLines: plan.outputs.map((line) => ({
        outputItemId: line.componentItemId,
        toLocationId: line.toLocationId,
        uom: line.uom,
        quantity: line.quantityProduced,
        reasonCode: 'disassembly_completion'
      }))
    },
    context,
    {
      idempotencyKey: params.idempotencyKey ?? null
    }
  );
}
