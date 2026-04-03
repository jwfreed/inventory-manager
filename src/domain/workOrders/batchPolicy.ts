import type { PoolClient } from 'pg';
import type { AtpLockTarget } from '../../domains/inventory';
import {
  ensureWorkOrderReservationsReady
} from '../../services/inventoryReservation.service';
import * as replayEngine from '../../services/inventoryReplayEngine';
import {
  isTerminalWorkOrderStatus
} from '../../services/workOrderLifecycle.service';
import {
  assertWorkOrderRoutingLine
} from '../../services/stageRouting.service';
import {
  compareBatchConsumeKey,
  compareBatchProduceKey
} from '../../services/workOrderExecution.ordering';
import type {
  NormalizedBatchConsumeLine,
  NormalizedBatchProduceLine,
  WorkOrderRow
} from '../../services/workOrderExecution.types';

type DomainError = Error & {
  code?: string;
  details?: Record<string, unknown>;
};

type LocationRow = {
  id: string;
  warehouse_id: string | null;
  role: string | null;
  is_sellable: boolean;
};

type ExistingBatchReplay = Awaited<ReturnType<typeof replayEngine.findPostedBatchByIdempotencyKey>>;

export type WorkOrderBatchPolicy = Readonly<{
  workOrder: WorkOrderRow;
  isDisassembly: boolean;
  existingBatchReplay: ExistingBatchReplay | null;
  consumeLinesOrdered: ReadonlyArray<NormalizedBatchConsumeLine>;
  produceLinesOrdered: ReadonlyArray<NormalizedBatchProduceLine>;
  reservationSnapshot: Awaited<ReturnType<typeof ensureWorkOrderReservationsReady>>;
  warehouseByLocationId: ReadonlyMap<string, string>;
  lockTargets: ReadonlyArray<AtpLockTarget>;
}>;

function domainError(code: string, details?: Record<string, unknown>): DomainError {
  const error = new Error(code) as DomainError;
  error.code = code;
  error.details = details;
  return error;
}

async function fetchWorkOrderForPolicy(
  tenantId: string,
  workOrderId: string,
  client: PoolClient
): Promise<WorkOrderRow | null> {
  const result = await client.query<WorkOrderRow>(
    `SELECT *
       FROM work_orders
      WHERE id = $1
        AND tenant_id = $2
      FOR UPDATE`,
    [workOrderId, tenantId]
  );
  return result.rowCount === 0 ? null : result.rows[0];
}

function freezeArray<T>(value: T[]) {
  return Object.freeze(value.map((entry) => Object.freeze({ ...entry })));
}

function buildAtpLockTargets(params: {
  tenantId: string;
  consumeLinesOrdered: ReadonlyArray<NormalizedBatchConsumeLine>;
  produceLinesOrdered: ReadonlyArray<NormalizedBatchProduceLine>;
  warehouseByLocationId: ReadonlyMap<string, string>;
}): ReadonlyArray<AtpLockTarget> {
  return Object.freeze([
    ...params.consumeLinesOrdered.map((line) => ({
      tenantId: params.tenantId,
      warehouseId: params.warehouseByLocationId.get(line.fromLocationId) ?? '',
      itemId: line.componentItemId
    })),
    ...params.produceLinesOrdered.map((line) => ({
      tenantId: params.tenantId,
      warehouseId: params.warehouseByLocationId.get(line.toLocationId) ?? '',
      itemId: line.outputItemId
    }))
  ]);
}

export async function evaluateWorkOrderBatchPolicy(params: {
  tenantId: string;
  workOrderId: string;
  batchIdempotencyKey: string | null;
  requestHash: string;
  normalizedConsumes: ReadonlyArray<NormalizedBatchConsumeLine>;
  normalizedProduces: ReadonlyArray<NormalizedBatchProduceLine>;
  client: PoolClient;
}): Promise<WorkOrderBatchPolicy> {
  let existingBatchReplay: ExistingBatchReplay | null = null;
  if (params.batchIdempotencyKey) {
    existingBatchReplay = await replayEngine.findPostedBatchByIdempotencyKey(
      params.client,
      params.tenantId,
      params.batchIdempotencyKey,
      params.requestHash
    );
  }

  const workOrder = await fetchWorkOrderForPolicy(
    params.tenantId,
    params.workOrderId,
    params.client
  );
  if (!workOrder) {
    throw new Error('WO_NOT_FOUND');
  }
  if (!existingBatchReplay && isTerminalWorkOrderStatus(workOrder.status)) {
    throw new Error('WO_INVALID_STATE');
  }

  const reservationSnapshot = existingBatchReplay
    ? []
    : await ensureWorkOrderReservationsReady(
      params.tenantId,
      params.workOrderId,
      params.client
    );

  const consumeLinesOrdered = freezeArray(
    [...params.normalizedConsumes].sort(compareBatchConsumeKey)
  );
  const produceLinesOrdered = freezeArray(
    [...params.normalizedProduces].sort(compareBatchProduceKey)
  );
  if (existingBatchReplay) {
    const reservationSnapshot: Awaited<ReturnType<typeof ensureWorkOrderReservationsReady>> = [];
    return Object.freeze({
      workOrder,
      isDisassembly: workOrder.kind === 'disassembly',
      existingBatchReplay,
      consumeLinesOrdered,
      produceLinesOrdered,
      reservationSnapshot,
      warehouseByLocationId: new Map<string, string>(),
      lockTargets: Object.freeze([] as AtpLockTarget[])
    });
  }
  const isDisassembly = workOrder.kind === 'disassembly';

  if (!isDisassembly) {
    for (const line of produceLinesOrdered) {
      if (line.outputItemId !== workOrder.output_item_id) {
        throw new Error('WO_BATCH_ITEM_MISMATCH');
      }
    }
  } else {
    for (const line of consumeLinesOrdered) {
      if (line.componentItemId !== workOrder.output_item_id) {
        throw new Error('WO_DISASSEMBLY_INPUT_MISMATCH');
      }
    }
  }

  const itemIds = Array.from(
    new Set([
      ...consumeLinesOrdered.map((line) => line.componentItemId),
      ...produceLinesOrdered.map((line) => line.outputItemId)
    ])
  );
  if (itemIds.length > 0) {
    const itemRes = await params.client.query<{ id: string }>(
      `SELECT id
         FROM items
        WHERE id = ANY($1)
          AND tenant_id = $2`,
      [itemIds, params.tenantId]
    );
    const found = new Set(itemRes.rows.map((row) => row.id));
    const missingItems = itemIds.filter((id) => !found.has(id));
    if (missingItems.length > 0) {
      throw new Error(`WO_BATCH_ITEMS_MISSING:${missingItems.join(',')}`);
    }
  }

  const locationIds = Array.from(
    new Set([
      ...consumeLinesOrdered.map((line) => line.fromLocationId),
      ...produceLinesOrdered.map((line) => line.toLocationId)
    ])
  );
  const warehouseByLocationId = new Map<string, string>();
  if (locationIds.length > 0) {
    const locationRes = await params.client.query<LocationRow>(
      `SELECT id, warehouse_id, role, is_sellable
         FROM locations
        WHERE id = ANY($1)
          AND tenant_id = $2`,
      [locationIds, params.tenantId]
    );
    const found = new Set(locationRes.rows.map((row) => row.id));
    const missingLocations = locationIds.filter((id) => !found.has(id));
    if (missingLocations.length > 0) {
      throw new Error(`WO_BATCH_LOCATIONS_MISSING:${missingLocations.join(',')}`);
    }
    for (const row of locationRes.rows) {
      if (row.warehouse_id) {
        warehouseByLocationId.set(row.id, row.warehouse_id);
      }
    }

    const missingWarehouseBindings = [
      ...consumeLinesOrdered
        .filter((line) => !warehouseByLocationId.get(line.fromLocationId))
        .map((line) => line.fromLocationId),
      ...produceLinesOrdered
        .filter((line) => !warehouseByLocationId.get(line.toLocationId))
        .map((line) => line.toLocationId)
    ];
    if (missingWarehouseBindings.length > 0) {
      throw new Error(
        `WO_BATCH_LOCATION_WAREHOUSE_MISSING:${Array.from(new Set(missingWarehouseBindings)).join(',')}`
      );
    }

    const locationById = new Map(locationRes.rows.map((row) => [row.id, row]));
    for (const line of consumeLinesOrdered) {
      const consumeLocation = locationById.get(line.fromLocationId);
      if (!consumeLocation?.is_sellable) {
        throw domainError('MANUFACTURING_CONSUMPTION_MUST_BE_SELLABLE', {
          workOrderId: params.workOrderId,
          componentItemId: line.componentItemId,
          locationId: line.fromLocationId
        });
      }
    }

    if (!isDisassembly) {
      const routingContext = {
        kind: workOrder.kind,
        outputItemId: workOrder.output_item_id,
        bomId: workOrder.bom_id,
        defaultConsumeLocationId: workOrder.default_consume_location_id,
        defaultProduceLocationId: workOrder.default_produce_location_id,
        produceToLocationIdSnapshot: workOrder.produce_to_location_id_snapshot
      };
      for (const line of consumeLinesOrdered) {
        await assertWorkOrderRoutingLine({
          tenantId: params.tenantId,
          context: routingContext,
          componentItemId: line.componentItemId,
          consumeLocationId: line.fromLocationId,
          client: params.client
        });
      }
      for (const line of produceLinesOrdered) {
        await assertWorkOrderRoutingLine({
          tenantId: params.tenantId,
          context: routingContext,
          produceLocationId: line.toLocationId,
          client: params.client
        });
      }
    }
  }

  return Object.freeze({
    workOrder,
    isDisassembly,
    existingBatchReplay,
    consumeLinesOrdered,
    produceLinesOrdered,
    reservationSnapshot,
    warehouseByLocationId,
    lockTargets: buildAtpLockTargets({
      tenantId: params.tenantId,
      consumeLinesOrdered,
      produceLinesOrdered,
      warehouseByLocationId
    })
  });
}
