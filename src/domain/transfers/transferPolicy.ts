import type { PoolClient } from 'pg';
import { roundQuantity, toNumber } from '../../lib/numbers';
import { resolveWarehouseIdForLocation } from '../../services/warehouseDefaults.service';
import { assertLocationInventoryReady } from '../inventory/binProvisioning';

/**
 * Transfer truth model decision: location-level.
 *
 * Transfers mutate inventory at the location boundary only. Bins are required
 * so every inventory-capable location is addressable, but bins are not part of
 * transfer identity, deterministic hashing, or cost relocation inputs.
 */
export const TRANSFER_ADDRESSING_MODEL = 'location-level' as const;
export const TRANSFER_BIN_POLICY = 'readiness-only' as const;
export const TRANSFER_CROSS_WAREHOUSE_POLICY = 'explicitly_allowed' as const;

type DomainError = Error & {
  code?: string;
  details?: Record<string, unknown>;
};

type LocationPolicyRow = {
  role: string | null;
  is_sellable: boolean | null;
};

export type TransferPolicyInput = {
  tenantId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  warehouseId?: string | null;
  itemId: string;
  quantity: number;
  uom: string;
  sourceType: string;
  sourceId: string;
  movementType?: string;
  qcAction?: 'accept' | 'hold' | 'reject';
  reasonCode?: string;
  notes?: string;
  occurredAt?: Date;
  actorId?: string | null;
  overrideNegative?: boolean;
  overrideReason?: string | null;
  idempotencyKey?: string | null;
  lotId?: string | null;
  serialNumbers?: string[] | null;
  inventoryCommandEndpoint?: string | null;
  inventoryCommandOperation?: string | null;
  inventoryCommandRequestBody?: Record<string, unknown> | null;
};

export type PreparedTransferMutation = Readonly<{
  tenantId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  warehouseId: string | null;
  itemId: string;
  quantity: number;
  enteredQty: number;
  uom: string;
  sourceType: string;
  sourceId: string;
  movementType: string;
  qcAction?: 'accept' | 'hold' | 'reject';
  reasonCode: string;
  notes: string;
  occurredAt: Date;
  actorId: string | null;
  overrideNegative: boolean;
  overrideReason: string | null;
  idempotencyKey: string | null;
  lotId: string | null;
  serialNumbers: readonly string[] | null;
  inventoryCommandEndpoint: string | null;
  inventoryCommandOperation: string | null;
  inventoryCommandRequestBody: Record<string, unknown> | null;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
}>;

function domainError(code: string, details?: Record<string, unknown>): DomainError {
  const error = new Error(code) as DomainError;
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function resolveTransferOccurredAt(occurredAt?: Date): Date {
  // Canonical defaulting boundary: wrappers may omit occurredAt, but prepared
  // transfer mutations must always carry a concrete timestamp downstream.
  return occurredAt ?? new Date();
}

async function loadLocationPolicyRow(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  notFoundCode: string
): Promise<LocationPolicyRow> {
  const result = await client.query<LocationPolicyRow>(
    `SELECT role, is_sellable
       FROM locations
      WHERE id = $1
        AND tenant_id = $2`,
    [locationId, tenantId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(notFoundCode);
  }
  return result.rows[0];
}

async function assertQcTransferPolicy(
  input: TransferPolicyInput,
  client: PoolClient
) {
  if (input.sourceType !== 'qc_event') {
    return;
  }

  if (!input.qcAction) {
    throw new Error('QC_ACTION_REQUIRED');
  }

  const [sourceLocation, destinationLocation] = await Promise.all([
    loadLocationPolicyRow(client, input.tenantId, input.sourceLocationId, 'TRANSFER_SOURCE_NOT_FOUND'),
    loadLocationPolicyRow(client, input.tenantId, input.destinationLocationId, 'TRANSFER_DESTINATION_NOT_FOUND')
  ]);

  if (sourceLocation.role !== 'QA' || sourceLocation.is_sellable) {
    throw new Error('QC_SOURCE_MUST_BE_QA');
  }

  if (input.qcAction === 'accept') {
    if (destinationLocation.role !== 'SELLABLE') {
      throw new Error('QC_ACCEPT_REQUIRES_SELLABLE_ROLE');
    }
    if (!destinationLocation.is_sellable) {
      throw new Error('QC_ACCEPT_REQUIRES_SELLABLE_FLAG');
    }
    return;
  }

  if (input.qcAction === 'hold') {
    if (destinationLocation.role !== 'HOLD') {
      throw new Error('QC_HOLD_REQUIRES_HOLD_ROLE');
    }
    if (destinationLocation.is_sellable) {
      throw new Error('QC_HOLD_MUST_NOT_BE_SELLABLE');
    }
    return;
  }

  if (destinationLocation.role !== 'REJECT') {
    throw new Error('QC_REJECT_REQUIRES_REJECT_ROLE');
  }
  if (destinationLocation.is_sellable) {
    throw new Error('QC_REJECT_MUST_NOT_BE_SELLABLE');
  }
}

function assertWarehouseScopeIntegrity(params: {
  requestedWarehouseId: string | null;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
}) {
  if (
    params.sourceWarehouseId !== params.destinationWarehouseId
    && TRANSFER_CROSS_WAREHOUSE_POLICY !== 'explicitly_allowed'
  ) {
    throw domainError('TRANSFER_CROSS_WAREHOUSE_NOT_ALLOWED', {
      sourceWarehouseId: params.sourceWarehouseId,
      destinationWarehouseId: params.destinationWarehouseId
    });
  }

  if (
    params.requestedWarehouseId
    && (
      params.sourceWarehouseId !== params.destinationWarehouseId
      || params.requestedWarehouseId !== params.sourceWarehouseId
    )
  ) {
    throw domainError('WAREHOUSE_SCOPE_MISMATCH', {
      providedWarehouseId: params.requestedWarehouseId,
      sourceWarehouseId: params.sourceWarehouseId,
      destinationWarehouseId: params.destinationWarehouseId
    });
  }
}

export async function prepareTransferMutation(
  input: TransferPolicyInput,
  client: PoolClient
): Promise<PreparedTransferMutation> {
  const requestedWarehouseId = input.warehouseId?.trim() ? input.warehouseId.trim() : null;
  const enteredQty = roundQuantity(toNumber(input.quantity));
  if (enteredQty <= 0) {
    throw new Error('TRANSFER_INVALID_QUANTITY');
  }
  if (input.sourceLocationId === input.destinationLocationId) {
    throw new Error('TRANSFER_SAME_LOCATION');
  }

  const [
    sourceWarehouseId,
    destinationWarehouseId
  ] = await Promise.all([
    resolveWarehouseIdForLocation(input.tenantId, input.sourceLocationId, client),
    resolveWarehouseIdForLocation(input.tenantId, input.destinationLocationId, client),
    assertLocationInventoryReady(input.sourceLocationId, input.tenantId, client),
    assertLocationInventoryReady(input.destinationLocationId, input.tenantId, client)
  ]);

  assertWarehouseScopeIntegrity({
    requestedWarehouseId,
    sourceWarehouseId,
    destinationWarehouseId
  });

  await assertQcTransferPolicy(input, client);

  return Object.freeze({
    tenantId: input.tenantId,
    sourceLocationId: input.sourceLocationId,
    destinationLocationId: input.destinationLocationId,
    warehouseId: requestedWarehouseId,
    itemId: input.itemId,
    quantity: input.quantity,
    enteredQty,
    uom: input.uom,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    movementType: input.movementType ?? 'transfer',
    qcAction: input.qcAction,
    reasonCode: input.reasonCode ?? 'transfer',
    notes: input.notes ?? 'Inventory transfer',
    occurredAt: resolveTransferOccurredAt(input.occurredAt),
    actorId: input.actorId ?? null,
    overrideNegative: input.overrideNegative ?? false,
    overrideReason: input.overrideReason ?? null,
    idempotencyKey: input.idempotencyKey?.trim() ? input.idempotencyKey.trim() : null,
    lotId: input.lotId ?? null,
    serialNumbers: input.serialNumbers ?? null,
    inventoryCommandEndpoint: input.inventoryCommandEndpoint ?? null,
    inventoryCommandOperation: input.inventoryCommandOperation ?? null,
    inventoryCommandRequestBody: input.inventoryCommandRequestBody ?? null,
    sourceWarehouseId,
    destinationWarehouseId
  });
}
