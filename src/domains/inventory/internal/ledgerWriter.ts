import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { buildMovementDeterministicHash, sortDeterministicMovementLines } from '../../../modules/platform/application/inventoryMovementDeterminism';
import { classifyInventoryMovementLineAction } from '../../../modules/platform/application/inventoryMovementLineSemantics';

type InventoryMovementInput = {
  id?: string;
  tenantId: string;
  movementType: string;
  status: string;
  externalRef: string;
  sourceType?: string | null;
  sourceId?: string | null;
  idempotencyKey?: string | null;
  occurredAt: Date | string;
  postedAt?: Date | string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
  lotId?: string | null;
  productionBatchId?: string | null;
  movementDeterministicHash?: string | null;
  reversalOfMovementId?: string | null;
  reversedByMovementId?: string | null;
  reversalReason?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

type InventoryMovementLineInput = {
  id?: string;
  tenantId: string;
  movementId: string;
  movementType: string;
  sourceLineId: string;
  eventTimestamp: Date | string;
  itemId: string;
  locationId: string;
  quantityDelta: number;
  uom: string;
  quantityDeltaEntered?: number | null;
  uomEntered?: string | null;
  quantityDeltaCanonical?: number | null;
  canonicalUom?: string | null;
  uomDimension?: string | null;
  unitCost?: number | null;
  extendedCost?: number | null;
  reasonCode?: string | null;
  lineNotes?: string | null;
  createdAt?: Date | string;
  recordedAt?: Date | string | null;
};

export type PersistInventoryMovementLineInput = Omit<InventoryMovementLineInput, 'tenantId' | 'movementId' | 'movementType'> & {
  warehouseId: string;
  sourceLineId: string;
  eventTimestamp: Date | string;
};

export type PersistInventoryMovementInput = Omit<InventoryMovementInput, 'movementDeterministicHash'> & {
  lines: PersistInventoryMovementLineInput[];
};

type InventoryMovementResult = {
  id: string;
  created: boolean;
};

export type PersistInventoryMovementResult = {
  movementId: string;
  created: boolean;
  movementDeterministicHash: string | null;
  lineIds: string[];
};

const ENFORCE_EXTERNAL_REF = process.env.ENFORCE_INVENTORY_MOVEMENT_EXTERNAL_REF === 'true';

async function createInventoryMovement(
  client: PoolClient,
  input: InventoryMovementInput
): Promise<InventoryMovementResult> {
  if (
    (input.movementType === 'receive' || input.movementType === 'transfer')
    && (!input.sourceType || !input.sourceId)
  ) {
    throw new Error('INVENTORY_MOVEMENT_SOURCE_REQUIRED');
  }

  if (!input.externalRef && ENFORCE_EXTERNAL_REF) {
    throw new Error('INVENTORY_MOVEMENT_EXTERNAL_REF_REQUIRED');
  }

  if (input.idempotencyKey) {
    const existing = await findMovementByIdempotencyKey(client, input.tenantId, input.idempotencyKey);
    if (existing) {
      return { id: existing, created: false };
    }
  }

  const existing = await findMovementByExternalRef(client, input.tenantId, input.externalRef);
  if (existing) {
    return { id: existing, created: false };
  }

  const id = input.id ?? uuidv4();
  const createdAt = input.createdAt ?? new Date();
  const updatedAt = input.updatedAt ?? createdAt;

  try {
    await client.query(
      `INSERT INTO inventory_movements (
          id, tenant_id, movement_type, status, external_ref, source_type, source_id, idempotency_key, occurred_at, posted_at, notes, metadata,
          lot_id, production_batch_id, movement_deterministic_hash, reversal_of_movement_id, reversed_by_movement_id, reversal_reason, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        id,
        input.tenantId,
        input.movementType,
        input.status,
        input.externalRef,
        input.sourceType ?? null,
        input.sourceId ?? null,
        input.idempotencyKey ?? null,
        input.occurredAt,
        input.postedAt ?? null,
        input.notes ?? null,
        input.metadata ?? null,
        input.lotId ?? null,
        input.productionBatchId ?? null,
        input.movementDeterministicHash ?? null,
        input.reversalOfMovementId ?? null,
        input.reversedByMovementId ?? null,
        input.reversalReason ?? null,
        createdAt,
        updatedAt
      ]
    );
  } catch (err: any) {
    if (err?.code === '23505') {
      if (input.sourceType && input.sourceId) {
        const existingBySource = await findMovementBySource(
          client,
          input.tenantId,
          input.sourceType,
          input.sourceId,
          input.movementType
        );
        if (existingBySource) {
          return { id: existingBySource, created: false };
        }
      }
      const existingId = await findMovementByExternalRef(client, input.tenantId, input.externalRef);
      if (existingId) {
        return { id: existingId, created: false };
      }
    }
    throw err;
  }

  return { id, created: true };
}

export async function persistInventoryMovement(
  client: PoolClient,
  input: PersistInventoryMovementInput
): Promise<PersistInventoryMovementResult> {
  if (input.lines.length === 0) {
    throw new Error('INVENTORY_MOVEMENT_LINES_REQUIRED');
  }

  const movementId = input.id ?? uuidv4();
  const createdAt = input.createdAt ?? new Date();
  const updatedAt = input.updatedAt ?? createdAt;
  const sortedLines = sortDeterministicMovementLines(input.lines, (line) => ({
    tenantId: input.tenantId,
    warehouseId: line.warehouseId,
    locationId: line.locationId,
    itemId: line.itemId,
    canonicalUom: line.canonicalUom ?? line.uom,
    sourceLineId: line.sourceLineId
  })).map((line) => ({
    ...line,
    id: line.id ?? uuidv4(),
    createdAt: line.createdAt ?? createdAt
  }));

  for (const line of sortedLines) {
    if (!line.sourceLineId) {
      throw new Error('INVENTORY_MOVEMENT_LINE_SOURCE_LINE_ID_REQUIRED');
    }
    if (!line.eventTimestamp) {
      throw new Error('INVENTORY_MOVEMENT_LINE_EVENT_TIMESTAMP_REQUIRED');
    }
  }

  const movementDeterministicHash = buildMovementDeterministicHash({
    tenantId: input.tenantId,
    movementType: input.movementType,
    occurredAt: input.occurredAt,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    lines: sortedLines.map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      quantityDelta: line.quantityDeltaCanonical ?? line.quantityDelta,
      uom: line.uom,
      canonicalUom: line.canonicalUom,
      unitCost: line.unitCost ?? null,
      reasonCode: line.reasonCode ?? null
    }))
  });

  const movement = await createInventoryMovement(client, {
    ...input,
    id: movementId,
    movementDeterministicHash,
    createdAt,
    updatedAt
  });
  if (!movement.created) {
    return {
      movementId: movement.id,
      created: false,
      movementDeterministicHash: null,
      lineIds: []
    };
  }

  for (const line of sortedLines) {
    await createInventoryMovementLine(client, {
      id: line.id,
      tenantId: input.tenantId,
      movementId,
      movementType: input.movementType,
      sourceLineId: line.sourceLineId,
      eventTimestamp: line.eventTimestamp,
      itemId: line.itemId,
      locationId: line.locationId,
      quantityDelta: line.quantityDelta,
      uom: line.uom,
      quantityDeltaEntered: line.quantityDeltaEntered ?? null,
      uomEntered: line.uomEntered ?? null,
      quantityDeltaCanonical: line.quantityDeltaCanonical ?? null,
      canonicalUom: line.canonicalUom ?? null,
      uomDimension: line.uomDimension ?? null,
      unitCost: line.unitCost ?? null,
      extendedCost: line.extendedCost ?? null,
      reasonCode: line.reasonCode ?? null,
      lineNotes: line.lineNotes ?? null,
      createdAt: line.createdAt,
      recordedAt: line.recordedAt ?? createdAt
    });
  }

  return {
    movementId,
    created: true,
    movementDeterministicHash,
    lineIds: sortedLines.map((line) => line.id!)
  };
}

async function createInventoryMovementLine(
  client: PoolClient,
  input: InventoryMovementLineInput
): Promise<string> {
  const id = input.id ?? uuidv4();
  const createdAt = input.createdAt ?? new Date();
  const recordedAt = input.recordedAt ?? createdAt;
  if (!input.sourceLineId) {
    throw new Error('INVENTORY_MOVEMENT_LINE_SOURCE_LINE_ID_REQUIRED');
  }
  if (!input.eventTimestamp) {
    throw new Error('INVENTORY_MOVEMENT_LINE_EVENT_TIMESTAMP_REQUIRED');
  }
  classifyInventoryMovementLineAction({
    movementType: input.movementType,
    quantityDelta: Number(input.quantityDeltaCanonical ?? input.quantityDelta),
    reasonCode: input.reasonCode ?? null
  });
  const enforceCanonical =
    process.env.ENFORCE_CANONICAL_MOVEMENT_FIELDS === 'true' ||
    (process.env.CANONICAL_MOVEMENT_REQUIRED_AFTER
      ? new Date(createdAt).getTime() >= new Date(process.env.CANONICAL_MOVEMENT_REQUIRED_AFTER).getTime()
      : false);
  if (
    enforceCanonical &&
    (input.quantityDeltaCanonical === null ||
      input.quantityDeltaCanonical === undefined ||
      !input.canonicalUom ||
      !input.uomDimension ||
      input.quantityDeltaEntered === null ||
      input.quantityDeltaEntered === undefined ||
      !input.uomEntered)
  ) {
    throw new Error('MOVEMENT_CANONICAL_FIELDS_REQUIRED');
  }

  await client.query(
    `INSERT INTO inventory_movement_lines (
        id, tenant_id, movement_id, source_line_id, event_timestamp, recorded_at,
        item_id, location_id, quantity_delta, uom,
        quantity_delta_entered, uom_entered, quantity_delta_canonical, canonical_uom, uom_dimension,
        unit_cost, extended_cost, reason_code, line_notes, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      id,
      input.tenantId,
      input.movementId,
      input.sourceLineId,
      input.eventTimestamp,
      recordedAt,
      input.itemId,
      input.locationId,
      input.quantityDelta,
      input.uom,
      input.quantityDeltaEntered ?? null,
      input.uomEntered ?? null,
      input.quantityDeltaCanonical ?? null,
      input.canonicalUom ?? null,
      input.uomDimension ?? null,
      input.unitCost ?? null,
      input.extendedCost ?? null,
      input.reasonCode ?? null,
      input.lineNotes ?? null,
      createdAt
    ]
  );

  return id;
}

async function findMovementByExternalRef(
  client: PoolClient,
  tenantId: string,
  externalRef: string
): Promise<string | null> {
  if (!externalRef) return null;
  const res = await client.query<{ id: string }>(
    'SELECT id FROM inventory_movements WHERE tenant_id = $1 AND external_ref = $2 LIMIT 1',
    [tenantId, externalRef]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0].id;
}

async function findMovementBySource(
  client: PoolClient,
  tenantId: string,
  sourceType: string,
  sourceId: string,
  movementType: string
): Promise<string | null> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = $2
        AND source_id = $3
        AND movement_type = $4
      LIMIT 1`,
    [tenantId, sourceType, sourceId, movementType]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0].id;
}

async function findMovementByIdempotencyKey(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string
): Promise<string | null> {
  if (!idempotencyKey) return null;
  const res = await client.query<{ id: string }>(
    'SELECT id FROM inventory_movements WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1',
    [tenantId, idempotencyKey]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0].id;
}
