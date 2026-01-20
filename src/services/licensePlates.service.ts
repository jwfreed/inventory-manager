import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { recordAuditLog } from '../lib/audit';
import { getCanonicalMovementFields } from './uomCanonical.service';
import { validateSufficientStock } from './stockValidation.service';
import { roundQuantity, toNumber } from '../lib/numbers';

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
  return withTransaction(async (client) => {
    const now = new Date();
    
    // Get LPN details
    const lpn = await getLicensePlateById(tenantId, data.licensePlateId, client);
    if (!lpn) {
      throw new Error('LPN_NOT_FOUND');
    }

    if (lpn.locationId !== data.fromLocationId) {
      throw new Error('LPN_LOCATION_MISMATCH');
    }

    if (lpn.status !== 'active') {
      throw new Error('LPN_NOT_ACTIVE');
    }

    const qty = roundQuantity(toNumber(lpn.quantity));
    const validation = await validateSufficientStock(
      tenantId,
      now,
      [
        {
          itemId: lpn.itemId,
          locationId: data.fromLocationId,
          uom: lpn.uom,
          quantityToConsume: qty
        }
      ],
      {
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        overrideRequested: data.overrideNegative,
        overrideReason: data.overrideReason ?? null,
        overrideReference: `lpn_move:${lpn.lpn}`
      }
    );

    // Create inventory movement for the LPN transfer
    const movementId = uuidv4();
    await client.query(
      `INSERT INTO inventory_movements (
        id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, metadata, created_at, updated_at
      ) VALUES ($1, $2, 'transfer', 'posted', $3, $4, $4, $5, $6, $4, $4)`,
      [
        movementId,
        tenantId,
        `lpn_move:${lpn.lpn}`,
        now,
        data.notes ?? `LPN ${lpn.lpn} moved from ${lpn.locationCode} to new location`,
        validation.overrideMetadata ?? null
      ]
    );

    // Create movement lines (negative from source, positive to destination)
    const lineIdOut = uuidv4();
    const lineIdIn = uuidv4();

    const canonicalOut = await getCanonicalMovementFields(
      tenantId,
      lpn.itemId,
      -qty,
      lpn.uom,
      client
    );
    await client.query(
      `INSERT INTO inventory_movement_lines (
        id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom,
        quantity_delta_entered, uom_entered, quantity_delta_canonical, canonical_uom, uom_dimension,
        reason_code, line_notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'lpn_transfer', $13)`,
      [
        lineIdOut,
        tenantId,
        movementId,
        lpn.itemId,
        data.fromLocationId,
        canonicalOut.quantityDeltaCanonical,
        canonicalOut.canonicalUom,
        canonicalOut.quantityDeltaEntered,
        canonicalOut.uomEntered,
        canonicalOut.quantityDeltaCanonical,
        canonicalOut.canonicalUom,
        canonicalOut.uomDimension,
        `LPN ${lpn.lpn} out`
      ]
    );

    const canonicalIn = await getCanonicalMovementFields(
      tenantId,
      lpn.itemId,
      qty,
      lpn.uom,
      client
    );
    await client.query(
      `INSERT INTO inventory_movement_lines (
        id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom,
        quantity_delta_entered, uom_entered, quantity_delta_canonical, canonical_uom, uom_dimension,
        reason_code, line_notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'lpn_transfer', $13)`,
      [
        lineIdIn,
        tenantId,
        movementId,
        lpn.itemId,
        data.toLocationId,
        canonicalIn.quantityDeltaCanonical,
        canonicalIn.canonicalUom,
        canonicalIn.quantityDeltaEntered,
        canonicalIn.uomEntered,
        canonicalIn.quantityDeltaCanonical,
        canonicalIn.canonicalUom,
        canonicalIn.uomDimension,
        `LPN ${lpn.lpn} in`
      ]
    );

    // Link the LPN to the movement
    await client.query(
      `INSERT INTO inventory_movement_lpns (
        id, tenant_id, inventory_movement_line_id, license_plate_id, quantity_delta, uom
      ) VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
      [
        uuidv4(), tenantId, lineIdOut, data.licensePlateId, canonicalOut.quantityDeltaCanonical, canonicalOut.canonicalUom,
        uuidv4(), tenantId, lineIdIn, data.licensePlateId, canonicalIn.quantityDeltaCanonical, canonicalIn.canonicalUom
      ]
    );

    if (validation.overrideMetadata && actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'negative_override',
          entityType: 'inventory_movement',
          entityId: movementId,
          occurredAt: now,
          metadata: {
            reason: validation.overrideMetadata.override_reason ?? null,
            reference: validation.overrideMetadata.override_reference ?? null,
            lpnId: data.licensePlateId,
            itemId: lpn.itemId,
            locationId: data.fromLocationId,
            uom: lpn.uom,
            quantity: qty
          }
        },
        client
      );
    }

    // Update LPN location
    await client.query(
      'UPDATE license_plates SET location_id = $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
      [data.toLocationId, now, data.licensePlateId, tenantId]
    );

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
            lpn: lpn.lpn,
            fromLocationId: data.fromLocationId,
            toLocationId: data.toLocationId,
            movementId
          }
        },
        client
      );
    }

    return getLicensePlateById(tenantId, data.licensePlateId, client);
  });
}

/**
 * Refresh the inventory levels materialized view
 */
export async function refreshInventoryLevelsByLpn(): Promise<void> {
  await query('SELECT refresh_inventory_levels_by_lpn()');
}
