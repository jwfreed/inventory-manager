import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { recordAuditLog } from '../lib/audit';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import { hashTransactionalIdempotencyRequest } from '../lib/transactionalIdempotency';
import { getCanonicalMovementFields } from './uomCanonical.service';
import { validateSufficientStock } from './stockValidation.service';
import { roundQuantity, toNumber } from '../lib/numbers';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import {
  createInventoryMovement,
  createInventoryMovementLine,
} from '../domains/inventory';
import { relocateTransferCostLayersInTx } from './transferCosting.service';
import { runInventoryCommand, type InventoryCommandProjectionOp } from '../modules/platform/application/runInventoryCommand';
import {
  buildInventoryBalanceProjectionOp,
  buildMovementPostedEvent,
  buildPostedDocumentReplayResult,
  persistMovementDeterministicHashFromLedger,
  sortDeterministicMovementLines
} from '../modules/platform/application/inventoryMutationSupport';
import { buildInventoryRegistryEvent } from '../modules/platform/application/inventoryEventRegistry';

export type LpnStatus = 'active' | 'consumed' | 'shipped' | 'damaged' | 'quarantine' | 'expired';

export interface CreateLpnInput {
  lpn: string;
  itemId: string;
  lotId?: string | null;
  locationId: string;
  parentLpnId?: string | null;
  quantity: number;
  uom: string;
  containerType?: string | null;
  receivedAt?: string | null;
  expirationDate?: string | null;
  purchaseOrderReceiptId?: string | null;
  productionDate?: string | null;
  notes?: string | null;
  metadata?: Record<string, any> | null;
}

export interface UpdateLpnInput {
  locationId?: string;
  quantity?: number;
  status?: LpnStatus;
  notes?: string | null;
  metadata?: Record<string, any> | null;
}

export interface LpnMovementInput {
  licensePlateId: string;
  fromLocationId: string;
  toLocationId: string;
  notes?: string | null;
  overrideNegative?: boolean;
  overrideReason?: string | null;
  idempotencyKey?: string | null;
}

function buildLicensePlateMovedEvent(params: {
  licensePlateId: string;
  movementId: string;
  fromLocationId: string;
  toLocationId: string;
  producerIdempotencyKey?: string | null;
}) {
  return buildInventoryRegistryEvent('licensePlateMoved', {
    producerIdempotencyKey: params.producerIdempotencyKey,
    payload: {
      licensePlateId: params.licensePlateId,
      movementId: params.movementId,
      fromLocationId: params.fromLocationId,
      toLocationId: params.toLocationId
    }
  });
}

function licensePlateIntegrityError(details: Record<string, unknown>) {
  const error = new Error('LICENSE_PLATE_INTEGRITY_FAILED') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = 'LICENSE_PLATE_INTEGRITY_FAILED';
  error.details = details;
  return error;
}

async function verifyLicensePlateInventoryIntegrity(params: {
  tenantId: string;
  movementId: string;
  licensePlateId: string;
  expectedLocationId: string;
  expectedQuantity: number;
  expectedUom: string;
  client: PoolClient;
}) {
  const lineLinkResult = await params.client.query<{
    movement_line_id: string;
    location_id: string;
    movement_qty: string | number;
    movement_uom: string;
    lpn_qty: string | number;
  }>(
    `SELECT iml.id AS movement_line_id,
            iml.location_id,
            COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) AS movement_qty,
            COALESCE(iml.canonical_uom, iml.uom) AS movement_uom,
            COALESCE(SUM(imlp.quantity_delta), 0) AS lpn_qty
       FROM inventory_movement_lines iml
       LEFT JOIN inventory_movement_lpns imlp
         ON imlp.inventory_movement_line_id = iml.id
        AND imlp.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND iml.movement_id = $2
      GROUP BY iml.id, iml.location_id, COALESCE(iml.quantity_delta_canonical, iml.quantity_delta), COALESCE(iml.canonical_uom, iml.uom)
      ORDER BY iml.created_at ASC, iml.id ASC`,
    [params.tenantId, params.movementId]
  );
  if ((lineLinkResult.rowCount ?? 0) === 0) {
    throw licensePlateIntegrityError({
      movementId: params.movementId,
      reason: 'movement_lines_missing'
    });
  }
  for (const row of lineLinkResult.rows) {
    if (Math.abs(toNumber(row.movement_qty) - toNumber(row.lpn_qty)) > 1e-6) {
      throw licensePlateIntegrityError({
        movementId: params.movementId,
        licensePlateId: params.licensePlateId,
        movementLineId: row.movement_line_id,
        reason: 'movement_lpn_quantity_mismatch',
        movementQty: toNumber(row.movement_qty),
        lpnQty: toNumber(row.lpn_qty),
        uom: row.movement_uom
      });
    }
  }

  const plateResult = await params.client.query<{
    location_id: string;
    quantity: string | number;
    uom: string;
  }>(
    `SELECT location_id, quantity, uom
       FROM license_plates
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [params.tenantId, params.licensePlateId]
  );
  if ((plateResult.rowCount ?? 0) === 0) {
    throw licensePlateIntegrityError({
      movementId: params.movementId,
      licensePlateId: params.licensePlateId,
      reason: 'license_plate_missing'
    });
  }
  const plateRow = plateResult.rows[0];
  if (
    plateRow.location_id !== params.expectedLocationId
    || Math.abs(toNumber(plateRow.quantity) - params.expectedQuantity) > 1e-6
    || plateRow.uom !== params.expectedUom
  ) {
    throw licensePlateIntegrityError({
      movementId: params.movementId,
      licensePlateId: params.licensePlateId,
      reason: 'license_plate_state_mismatch',
      expectedLocationId: params.expectedLocationId,
      actualLocationId: plateRow.location_id,
      expectedQuantity: params.expectedQuantity,
      actualQuantity: toNumber(plateRow.quantity),
      expectedUom: params.expectedUom,
      actualUom: plateRow.uom
    });
  }
}

async function buildLicensePlateMoveReplayResult(params: {
  tenantId: string;
  licensePlateId: string;
  movementId: string;
  fromLocationId: string;
  toLocationId: string;
  expectedDeterministicHash?: string | null;
  producerIdempotencyKey?: string | null;
  client: PoolClient;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.movementId,
        expectedLineCount: 2,
        expectedDeterministicHash: params.expectedDeterministicHash ?? null
      }
    ],
    client: params.client,
    preFetchIntegrityCheck: async () => {
      const currentLpn = await getLicensePlateById(params.tenantId, params.licensePlateId, params.client);
      if (!currentLpn) {
        throw new Error('LPN_NOT_FOUND');
      }
      await verifyLicensePlateInventoryIntegrity({
        tenantId: params.tenantId,
        movementId: params.movementId,
        licensePlateId: params.licensePlateId,
        expectedLocationId: params.toLocationId,
        expectedQuantity: currentLpn.quantity,
        expectedUom: currentLpn.uom,
        client: params.client
      });
    },
    fetchAggregateView: () => getLicensePlateById(params.tenantId, params.licensePlateId, params.client),
    aggregateNotFoundError: new Error('LPN_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.movementId, params.producerIdempotencyKey),
      buildLicensePlateMovedEvent({
        licensePlateId: params.licensePlateId,
        movementId: params.movementId,
        fromLocationId: params.fromLocationId,
        toLocationId: params.toLocationId,
        producerIdempotencyKey: params.producerIdempotencyKey
      })
    ]
  });
}

/**
 * Generate a unique LPN if not provided
 * Format: LPN-{timestamp}-{random}
 */
export function generateLpn(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `LPN-${timestamp}-${random}`;
}

/**
 * Create a new license plate
 */
export async function createLicensePlate(
  tenantId: string,
  data: CreateLpnInput,
  actor?: { type: 'user' | 'system'; id?: string | null }
) {
  const lpnId = uuidv4();
  const lpn = data.lpn.trim() || generateLpn();
  const now = new Date();

  await withTransaction(async (client) => {
    // Check if LPN already exists
    const existing = await client.query(
      'SELECT id FROM license_plates WHERE tenant_id = $1 AND lpn = $2',
      [tenantId, lpn]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      throw new Error('LPN_ALREADY_EXISTS');
    }

    await client.query(
      `INSERT INTO license_plates (
        id, tenant_id, lpn, status, item_id, lot_id, location_id, parent_lpn_id,
        quantity, uom, container_type, received_at, expiration_date,
        purchase_order_receipt_id, production_date, notes, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)`,
      [
        lpnId,
        tenantId,
        lpn,
        'active',
        data.itemId,
        data.lotId ?? null,
        data.locationId,
        data.parentLpnId ?? null,
        data.quantity,
        data.uom,
        data.containerType ?? null,
        data.receivedAt ? new Date(data.receivedAt) : now,
        data.expirationDate ? new Date(data.expirationDate) : null,
        data.purchaseOrderReceiptId ?? null,
        data.productionDate ? new Date(data.productionDate) : null,
        data.notes ?? null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        now
      ]
    );

    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'create',
          entityType: 'license_plate',
          entityId: lpnId,
          occurredAt: now,
          metadata: {
            lpn,
            itemId: data.itemId,
            locationId: data.locationId,
            quantity: data.quantity,
            uom: data.uom
          }
        },
        client
      );
    }
  });

  return getLicensePlateById(tenantId, lpnId);
}

/**
 * Get a license plate by ID
 */
export async function getLicensePlateById(tenantId: string, id: string, client?: PoolClient) {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor(
    `SELECT lp.*,
            i.sku AS item_sku,
            i.name AS item_name,
            l.code AS location_code,
            l.name AS location_name,
            lot.lot_code
     FROM license_plates lp
     INNER JOIN items i ON i.id = lp.item_id
     INNER JOIN locations l ON l.id = lp.location_id
     LEFT JOIN lots lot ON lot.id = lp.lot_id
     WHERE lp.id = $1 AND lp.tenant_id = $2`,
    [id, tenantId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    lpn: row.lpn,
    status: row.status,
    itemId: row.item_id,
    itemSku: row.item_sku,
    itemName: row.item_name,
    lotId: row.lot_id,
    lotNumber: row.lot_code ?? null,
    locationId: row.location_id,
    locationCode: row.location_code,
    locationName: row.location_name,
    parentLpnId: row.parent_lpn_id,
    quantity: Number(row.quantity),
    uom: row.uom,
    containerType: row.container_type,
    receivedAt: row.received_at,
    expirationDate: row.expiration_date,
    purchaseOrderReceiptId: row.purchase_order_receipt_id,
    productionDate: row.production_date,
    notes: row.notes,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Get a license plate by LPN string
 */
export async function getLicensePlateByLpn(tenantId: string, lpn: string) {
  const result = await query(
    'SELECT id FROM license_plates WHERE tenant_id = $1 AND lpn = $2',
    [tenantId, lpn]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return getLicensePlateById(tenantId, result.rows[0].id);
}

/**
 * List license plates with filters
 */
export async function listLicensePlates(
  tenantId: string,
  filters: {
    itemId?: string;
    locationId?: string;
    lotId?: string;
    status?: LpnStatus;
    search?: string;
    limit?: number;
    offset?: number;
  }
) {
  const conditions: string[] = ['lp.tenant_id = $1'];
  const params: any[] = [tenantId];

  if (filters.itemId) {
    params.push(filters.itemId);
    conditions.push(`lp.item_id = $${params.length}`);
  }

  if (filters.locationId) {
    params.push(filters.locationId);
    conditions.push(`lp.location_id = $${params.length}`);
  }

  if (filters.lotId) {
    params.push(filters.lotId);
    conditions.push(`lp.lot_id = $${params.length}`);
  }

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`lp.status = $${params.length}`);
  }

  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(lp.lpn ILIKE $${idx} OR i.sku ILIKE $${idx} OR i.name ILIKE $${idx})`);
  }

  const limit = Math.min(filters.limit ?? 100, 1000);
  const offset = filters.offset ?? 0;

  params.push(limit, offset);
  const where = conditions.join(' AND ');

  const { rows } = await query(
    `SELECT lp.*,
            i.sku AS item_sku,
            i.name AS item_name,
            l.code AS location_code,
            l.name AS location_name,
            lot.lot_code
     FROM license_plates lp
     INNER JOIN items i ON i.id = lp.item_id
     INNER JOIN locations l ON l.id = lp.location_id
     LEFT JOIN lots lot ON lot.id = lp.lot_id
     WHERE ${where}
     ORDER BY lp.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return rows.map((row) => ({
    id: row.id,
    lpn: row.lpn,
    status: row.status,
    itemId: row.item_id,
    itemSku: row.item_sku,
    itemName: row.item_name,
    lotId: row.lot_id,
    lotNumber: row.lot_code ?? null,
    locationId: row.location_id,
    locationCode: row.location_code,
    locationName: row.location_name,
    parentLpnId: row.parent_lpn_id,
    quantity: Number(row.quantity),
    uom: row.uom,
    containerType: row.container_type,
    receivedAt: row.received_at,
    expirationDate: row.expiration_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

/**
 * Update license plate
 */
export async function updateLicensePlate(
  tenantId: string,
  id: string,
  data: UpdateLpnInput,
  actor?: { type: 'user' | 'system'; id?: string | null }
) {
  const now = new Date();

  await withTransaction(async (client) => {
    const existing = await client.query(
      'SELECT * FROM license_plates WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId]
    );

    if (existing.rowCount === 0) {
      throw new Error('LPN_NOT_FOUND');
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (data.locationId !== undefined) {
      params.push(data.locationId);
      updates.push(`location_id = $${params.length}`);
    }

    if (data.quantity !== undefined) {
      params.push(data.quantity);
      updates.push(`quantity = $${params.length}`);
    }

    if (data.status !== undefined) {
      params.push(data.status);
      updates.push(`status = $${params.length}`);
    }

    if (data.notes !== undefined) {
      params.push(data.notes);
      updates.push(`notes = $${params.length}`);
    }

    if (data.metadata !== undefined) {
      params.push(data.metadata ? JSON.stringify(data.metadata) : null);
      updates.push(`metadata = $${params.length}`);
    }

    if (updates.length === 0) {
      return;
    }

    params.push(now, id, tenantId);
    const updateIdx = params.length - 2;

    await client.query(
      `UPDATE license_plates
       SET ${updates.join(', ')}, updated_at = $${params.length - 2}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}`,
      params
    );

    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'update',
          entityType: 'license_plate',
          entityId: id,
          occurredAt: now,
          metadata: { changes: data }
        },
        client
      );
    }
  });

  return getLicensePlateById(tenantId, id);
}

/**
 * Move an LPN to a new location (creates inventory movement)
 */
export async function moveLicensePlate(
  tenantId: string,
  data: LpnMovementInput,
  actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null }
) {
  const idempotencyKey = data.idempotencyKey?.trim() ? data.idempotencyKey.trim() : null;
  const requestHash = idempotencyKey
    ? hashTransactionalIdempotencyRequest({
      method: 'POST',
      endpoint: IDEMPOTENCY_ENDPOINTS.LICENSE_PLATES_MOVE,
      body: {
        licensePlateId: data.licensePlateId,
        fromLocationId: data.fromLocationId,
        toLocationId: data.toLocationId,
        notes: data.notes ?? null,
        overrideNegative: data.overrideNegative ?? false,
        overrideReason: data.overrideReason ?? null
      }
    })
    : null;

  let lpn: Awaited<ReturnType<typeof getLicensePlateById>> = null;
  let sourceWarehouseId = '';
  let destinationWarehouseId = '';

  return runInventoryCommand<any>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.LICENSE_PLATES_MOVE,
    operation: 'license_plate_move',
    idempotencyKey,
    requestHash,
    retryOptions: { isolationLevel: 'SERIALIZABLE', retries: 2 },
    onReplay: async ({ client }) => {
      const movementResult = await client.query<{ id: string }>(
        `SELECT id
           FROM inventory_movements
          WHERE tenant_id = $1
            AND source_type = 'lpn_move'
            AND idempotency_key = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE`,
        [tenantId, idempotencyKey]
      );
      if (!movementResult.rows[0]?.id) {
        throw new Error('LPN_MOVE_REPLAY_MOVEMENT_MISSING');
      }
      return (
        await buildLicensePlateMoveReplayResult({
          tenantId,
          licensePlateId: data.licensePlateId,
          movementId: movementResult.rows[0].id,
          fromLocationId: data.fromLocationId,
          toLocationId: data.toLocationId,
          producerIdempotencyKey: idempotencyKey,
          client
        })
      ).responseBody;
    },
    lockTargets: async (client) => {
      const lpnLock = await client.query(
        `SELECT id
           FROM license_plates
          WHERE tenant_id = $1
            AND id = $2
          FOR UPDATE`,
        [tenantId, data.licensePlateId]
      );
      if (lpnLock.rowCount === 0) {
        throw new Error('LPN_NOT_FOUND');
      }
      lpn = await getLicensePlateById(tenantId, data.licensePlateId, client);
      if (!lpn) {
        throw new Error('LPN_NOT_FOUND');
      }
      if (lpn.locationId !== data.fromLocationId) {
        throw new Error('LPN_LOCATION_MISMATCH');
      }
      if (lpn.status !== 'active') {
        throw new Error('LPN_NOT_ACTIVE');
      }

      sourceWarehouseId = await resolveWarehouseIdForLocation(tenantId, data.fromLocationId, client);
      destinationWarehouseId = await resolveWarehouseIdForLocation(tenantId, data.toLocationId, client);
      return [
        { tenantId, warehouseId: sourceWarehouseId, itemId: lpn.itemId },
        { tenantId, warehouseId: destinationWarehouseId, itemId: lpn.itemId }
      ];
    },
    execute: async ({ client }) => {
      if (!lpn) {
        throw new Error('LPN_NOT_FOUND');
      }
      const currentLpn = lpn;
      const now = new Date();
      const qty = roundQuantity(toNumber(currentLpn.quantity));
      const validation = await validateSufficientStock(
        tenantId,
        now,
        [
          {
            warehouseId: sourceWarehouseId,
            itemId: currentLpn.itemId,
            locationId: data.fromLocationId,
            uom: currentLpn.uom,
            quantityToConsume: qty
          }
        ],
        {
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          overrideRequested: data.overrideNegative,
          overrideReason: data.overrideReason ?? null,
          overrideReference: `lpn_move:${currentLpn.lpn}`
        },
        { client }
      );

      const canonicalOut = await getCanonicalMovementFields(
        tenantId,
        currentLpn.itemId,
        -qty,
        currentLpn.uom,
        client
      );
      const canonicalIn = await getCanonicalMovementFields(
        tenantId,
        currentLpn.itemId,
        qty,
        currentLpn.uom,
        client
      );
      if (
        canonicalOut.canonicalUom !== canonicalIn.canonicalUom
        || Math.abs(Math.abs(canonicalOut.quantityDeltaCanonical) - canonicalIn.quantityDeltaCanonical) > 1e-6
      ) {
        throw new Error('TRANSFER_CANONICAL_MISMATCH');
      }

      const preparedLines = sortDeterministicMovementLines(
        [
          {
            id: uuidv4(),
            warehouseId: sourceWarehouseId,
            itemId: currentLpn.itemId,
            locationId: data.fromLocationId,
            sourceLineId: `${data.licensePlateId}:out`,
            reasonCode: 'lpn_transfer_out',
            lineNotes: `LPN ${currentLpn.lpn} out`,
            canonicalFields: canonicalOut
          },
          {
            id: uuidv4(),
            warehouseId: destinationWarehouseId,
            itemId: currentLpn.itemId,
            locationId: data.toLocationId,
            sourceLineId: `${data.licensePlateId}:in`,
            reasonCode: 'lpn_transfer_in',
            lineNotes: `LPN ${currentLpn.lpn} in`,
            canonicalFields: canonicalIn
          }
        ],
        (line) => ({
          tenantId,
          warehouseId: line.warehouseId,
          locationId: line.locationId,
          itemId: line.itemId,
          canonicalUom: line.canonicalFields.canonicalUom,
            sourceLineId: line.sourceLineId
        })
      );
      const movementId = uuidv4();
      const movement = await createInventoryMovement(client, {
        id: movementId,
        tenantId,
        movementType: 'transfer',
        status: 'posted',
        externalRef: `lpn_move:${currentLpn.lpn}:${idempotencyKey}`,
        idempotencyKey,
        sourceType: 'lpn_move',
        sourceId: idempotencyKey ?? movementId,
        occurredAt: now,
        postedAt: now,
        notes: data.notes ?? `LPN ${currentLpn.lpn} moved from ${currentLpn.locationCode} to new location`,
        metadata: validation.overrideMetadata ?? null,
        createdAt: now,
        updatedAt: now
      });

      if (!movement.created) {
        return buildLicensePlateMoveReplayResult({
          tenantId,
          licensePlateId: data.licensePlateId,
          movementId: movement.id,
          fromLocationId: data.fromLocationId,
          toLocationId: data.toLocationId,
          producerIdempotencyKey: idempotencyKey,
          client
        });
      }

      const projectionOps: InventoryCommandProjectionOp[] = [];
      const lineIdsByDirection = new Map<'out' | 'in', string>();

      for (const preparedLine of preparedLines) {
        await createInventoryMovementLine(client, {
          id: preparedLine.id,
          tenantId,
          movementId: movement.id,
          itemId: preparedLine.itemId,
          locationId: preparedLine.locationId,
          quantityDelta: preparedLine.canonicalFields.quantityDeltaCanonical,
          uom: preparedLine.canonicalFields.canonicalUom,
          quantityDeltaEntered: preparedLine.canonicalFields.quantityDeltaEntered,
          uomEntered: preparedLine.canonicalFields.uomEntered,
          quantityDeltaCanonical: preparedLine.canonicalFields.quantityDeltaCanonical,
          canonicalUom: preparedLine.canonicalFields.canonicalUom,
          uomDimension: preparedLine.canonicalFields.uomDimension,
          reasonCode: preparedLine.reasonCode,
          lineNotes: preparedLine.lineNotes
        });

        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: preparedLine.itemId,
            locationId: preparedLine.locationId,
            uom: preparedLine.canonicalFields.canonicalUom,
            deltaOnHand: preparedLine.canonicalFields.quantityDeltaCanonical
          })
        );

        lineIdsByDirection.set(
          preparedLine.canonicalFields.quantityDeltaCanonical < 0 ? 'out' : 'in',
          preparedLine.id
        );
      }
      await persistMovementDeterministicHashFromLedger(client, tenantId, movement.id);

      const outLineId = lineIdsByDirection.get('out');
      const inLineId = lineIdsByDirection.get('in');
      if (!outLineId || !inLineId) {
        throw new Error('LPN_MOVE_LINE_DIRECTIONS_MISSING');
      }

      await relocateTransferCostLayersInTx({
        client,
        tenantId,
        transferMovementId: movement.id,
        occurredAt: now,
        notes: data.notes ?? `LPN ${currentLpn.lpn} moved from ${currentLpn.locationCode} to new location`,
        pairs: [
          {
            itemId: currentLpn.itemId,
            sourceLocationId: data.fromLocationId,
            destinationLocationId: data.toLocationId,
            outLineId,
            inLineId,
            quantity: canonicalIn.quantityDeltaCanonical,
            uom: canonicalIn.canonicalUom
          }
        ]
      });

      await client.query(
        `INSERT INTO inventory_movement_lpns (
          id, tenant_id, inventory_movement_line_id, license_plate_id, quantity_delta, uom
        ) VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
        [
          uuidv4(),
          tenantId,
          outLineId,
          data.licensePlateId,
          canonicalOut.quantityDeltaCanonical,
          canonicalOut.canonicalUom,
          uuidv4(),
          tenantId,
          inLineId,
          data.licensePlateId,
          canonicalIn.quantityDeltaCanonical,
          canonicalIn.canonicalUom
        ]
      );

      projectionOps.push(async (projectionClient) => {
        if (validation.overrideMetadata && actor) {
          await recordAuditLog(
            {
              tenantId,
              actorType: actor.type,
              actorId: actor.id ?? null,
              action: 'negative_override',
              entityType: 'inventory_movement',
              entityId: movement.id,
              occurredAt: now,
              metadata: {
                reason: validation.overrideMetadata.override_reason ?? null,
                reference: validation.overrideMetadata.override_reference ?? null,
                lpnId: data.licensePlateId,
                itemId: currentLpn.itemId,
                locationId: data.fromLocationId,
                uom: currentLpn.uom,
                quantity: qty
              }
            },
            projectionClient
          );
        }
        await projectionClient.query(
          `UPDATE license_plates
              SET location_id = $1,
                  updated_at = $2
            WHERE id = $3
              AND tenant_id = $4`,
          [data.toLocationId, now, data.licensePlateId, tenantId]
        );
        await verifyLicensePlateInventoryIntegrity({
          tenantId,
          movementId: movement.id,
          licensePlateId: data.licensePlateId,
          expectedLocationId: data.toLocationId,
          expectedQuantity: qty,
          expectedUom: currentLpn.uom,
          client: projectionClient
        });
        if (actor) {
          await recordAuditLog(
            {
              tenantId,
              actorType: actor.type,
              actorId: actor.id ?? null,
              action: 'update',
              entityType: 'license_plate',
              entityId: data.licensePlateId,
              occurredAt: now,
              metadata: {
                lpn: currentLpn.lpn,
                fromLocationId: data.fromLocationId,
                toLocationId: data.toLocationId,
                movementId: movement.id
              }
            },
            projectionClient
          );
        }
      });

      const destinationLocationResult = await client.query<{
        code: string;
        name: string;
      }>(
        `SELECT code, name
           FROM locations
          WHERE tenant_id = $1
            AND id = $2`,
        [tenantId, data.toLocationId]
      );
      const destinationLocation = destinationLocationResult.rows[0];

      return {
        responseBody: {
          ...currentLpn,
          locationId: data.toLocationId,
          locationCode: destinationLocation?.code ?? currentLpn.locationCode,
          locationName: destinationLocation?.name ?? currentLpn.locationName,
          updatedAt: now.toISOString()
        },
        responseStatus: 200,
        events: [
          buildMovementPostedEvent(movement.id, idempotencyKey),
          buildLicensePlateMovedEvent({
            licensePlateId: data.licensePlateId,
            movementId: movement.id,
            fromLocationId: data.fromLocationId,
            toLocationId: data.toLocationId,
            producerIdempotencyKey: idempotencyKey
          })
        ],
        projectionOps
      };
    }
  });
}

/**
 * Refresh the inventory levels materialized view
 */
export async function refreshInventoryLevelsByLpn(): Promise<void> {
  await query('SELECT refresh_inventory_levels_by_lpn()');
}
