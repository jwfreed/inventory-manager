import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';

export type InventoryMovementInput = {
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
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

export type InventoryMovementLineInput = {
  id?: string;
  tenantId: string;
  movementId: string;
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
};

export type InventoryMovementResult = {
  id: string;
  created: boolean;
};

const ENFORCE_EXTERNAL_REF = process.env.ENFORCE_INVENTORY_MOVEMENT_EXTERNAL_REF === 'true';

export async function createInventoryMovement(
  client: PoolClient,
  input: InventoryMovementInput
): Promise<InventoryMovementResult> {
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
          id, tenant_id, movement_type, status, external_ref, source_type, source_id, idempotency_key, occurred_at, posted_at, notes, metadata, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
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

export async function createInventoryMovementLine(
  client: PoolClient,
  input: InventoryMovementLineInput
): Promise<string> {
  const id = input.id ?? uuidv4();
  const createdAt = input.createdAt ?? new Date();
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
        id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom,
        quantity_delta_entered, uom_entered, quantity_delta_canonical, canonical_uom, uom_dimension,
        unit_cost, extended_cost, reason_code, line_notes, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      id,
      input.tenantId,
      input.movementId,
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

export async function createInventoryMovementLines(
  client: PoolClient,
  inputs: InventoryMovementLineInput[]
): Promise<string[]> {
  const ids: string[] = [];
  for (const input of inputs) {
    const id = await createInventoryMovementLine(client, input);
    ids.push(id);
  }
  return ids;
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
