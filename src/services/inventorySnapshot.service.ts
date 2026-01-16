import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { assertItemExists, assertLocationExists } from './inventorySummary.service';
import { convertQuantity } from './masterData.service';
import { getItemUomConfigIfPresent } from './uomCanonical.service';
import {
  calculateAcceptedQuantity,
  loadPutawayTotals,
  loadReceiptLineContexts,
  loadQcBreakdown
} from './inbound/receivingAggregations';

export type InventorySnapshotRow = {
  itemId: string;
  locationId: string;
  uom: string;
  onHand: number;
  reserved: number;
  available: number;
  held: number;
  rejected: number;
  nonUsable: number;
  onOrder: number;
  inTransit: number;
  backordered: number;
  inventoryPosition: number;
  isLegacy?: boolean;
};

export type InventorySnapshotParams = {
  itemId: string;
  locationId: string;
  uom?: string;
};

export type InventorySnapshotSummaryParams = {
  itemId?: string;
  locationId?: string;
  limit?: number;
  offset?: number;
};

function normalizeQuantity(value: unknown): number {
  return roundQuantity(toNumber(value));
}

function isSameUom(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

let backordersTableAvailable: boolean | null = null;

async function hasBackordersTable(): Promise<boolean> {
  if (backordersTableAvailable !== null) return backordersTableAvailable;
  const { rows } = await query<{ exists: string | null }>(
    `SELECT to_regclass('inventory_backorders') AS exists`
  );
  backordersTableAvailable = Boolean(rows[0]?.exists);
  return backordersTableAvailable;
}

async function loadOnHand(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string | undefined,
  mode: 'canonical' | 'legacy'
): Promise<Map<string, number>> {
  const params: any[] = [tenantId, itemId, locationId];
  const uomFilter = uom
    ? mode === 'canonical'
      ? ` AND iml.canonical_uom = $${params.push(uom)}`
      : ` AND iml.uom = $${params.push(uom)}`
    : '';
  const { rows } = await query(
    `SELECT ${mode === 'canonical' ? 'iml.canonical_uom' : 'iml.uom'} AS uom,
            SUM(${mode === 'canonical' ? 'iml.quantity_delta_canonical' : 'iml.quantity_delta'}) AS on_hand
       FROM inventory_movement_lines iml
       JOIN inventory_movements im ON im.id = iml.movement_id
      WHERE im.status = 'posted'
        AND iml.tenant_id = $1
        AND im.tenant_id = $1
        AND iml.item_id = $2
        AND iml.location_id = $3
        ${mode === 'canonical' ? 'AND iml.quantity_delta_canonical IS NOT NULL' : 'AND iml.quantity_delta_canonical IS NULL'}
        ${uomFilter}
      GROUP BY ${mode === 'canonical' ? 'iml.canonical_uom' : 'iml.uom'}`,
    params
  );

  const map = new Map<string, number>();
  rows.forEach((row: any) => {
    map.set(row.uom, normalizeQuantity(row.on_hand));
  });
  return map;
}

async function loadReserved(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string | undefined,
  mode: 'canonical' | 'legacy'
): Promise<Map<string, number>> {
  const params: any[] = [tenantId, itemId, locationId];
  const uomFilter = uom
    ? mode === 'canonical'
      ? ` AND i.canonical_uom = $${params.push(uom)}`
      : ` AND r.uom = $${params.push(uom)}`
    : '';
  const { rows } = await query(
    `SELECT ${mode === 'canonical' ? 'i.canonical_uom' : 'r.uom'} AS uom,
            SUM(r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0)) AS reserved_qty
       FROM inventory_reservations r
       ${mode === 'canonical' ? 'JOIN items i ON i.id = r.item_id AND i.tenant_id = r.tenant_id' : ''}
      WHERE r.tenant_id = $1
        AND r.item_id = $2
        AND r.location_id = $3
        AND r.status IN ('open', 'released')
        ${mode === 'canonical' ? 'AND i.canonical_uom IS NOT NULL AND r.uom = i.canonical_uom' : ''}
        ${uomFilter}
      GROUP BY ${mode === 'canonical' ? 'i.canonical_uom' : 'r.uom'}`,
    params
  );

  const map = new Map<string, number>();
  rows.forEach((row: any) => {
    const remaining = roundQuantity(Math.max(0, normalizeQuantity(row.reserved_qty)));
    map.set(row.uom, remaining);
  });
  return map;
}

async function loadBackordered(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string | undefined,
  mode: 'canonical' | 'legacy'
): Promise<Map<string, number>> {
  if (!(await hasBackordersTable())) {
    return new Map<string, number>();
  }
  const params: any[] = [tenantId, itemId, locationId];
  const uomFilter = uom
    ? mode === 'canonical'
      ? ` AND i.canonical_uom = $${params.push(uom)}`
      : ` AND b.uom = $${params.push(uom)}`
    : '';
  const { rows } = await query(
    `SELECT ${mode === 'canonical' ? 'i.canonical_uom' : 'b.uom'} AS uom,
            SUM(b.quantity_backordered) AS backordered_qty
       FROM inventory_backorders b
       ${mode === 'canonical' ? 'JOIN items i ON i.id = b.item_id AND i.tenant_id = b.tenant_id' : ''}
      WHERE b.tenant_id = $1
        AND b.item_id = $2
        AND b.location_id = $3
        AND b.status = 'open'
        ${mode === 'canonical' ? 'AND i.canonical_uom IS NOT NULL AND b.uom = i.canonical_uom' : ''}
        ${uomFilter}
      GROUP BY ${mode === 'canonical' ? 'i.canonical_uom' : 'b.uom'}`,
    params
  );

  const map = new Map<string, number>();
  rows.forEach((row: any) => {
    map.set(row.uom, normalizeQuantity(row.backordered_qty));
  });
  return map;
}

async function loadOnOrderCanonical(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom?: string
): Promise<Map<string, number>> {
  const itemConfig = await getItemUomConfigIfPresent(tenantId, itemId);
  if (!itemConfig) {
    return new Map();
  }
  if (uom && !isSameUom(uom, itemConfig.canonicalUom)) {
    return new Map();
  }

  const params: any[] = [tenantId, itemId, locationId];
  const { rows } = await query(
    `SELECT
        pol.uom AS ordered_uom,
        SUM(pol.quantity_ordered) AS total_ordered,
        SUM(COALESCE(rec.total_received, 0)) AS total_received
       FROM purchase_order_lines pol
       JOIN purchase_orders po ON po.id = pol.purchase_order_id
       LEFT JOIN (
         SELECT purchase_order_line_id, SUM(quantity_received) AS total_received
           FROM purchase_order_receipt_lines
          GROUP BY purchase_order_line_id
       ) rec ON rec.purchase_order_line_id = pol.id
      WHERE pol.tenant_id = $1
        AND po.tenant_id = $1
        AND pol.item_id = $2
        AND po.ship_to_location_id = $3
        AND po.status IN ('approved','partially_received')
      GROUP BY pol.uom`,
    params
  );

  const map = new Map<string, number>();
  for (const row of rows) {
    const ordered = normalizeQuantity(row.total_ordered);
    const received = normalizeQuantity(row.total_received);
    const outstanding = roundQuantity(Math.max(0, ordered - received));
    if (outstanding <= 0) continue;

    let canonicalQty = outstanding;
    if (!isSameUom(row.ordered_uom, itemConfig.canonicalUom)) {
      try {
        canonicalQty = await convertQuantity(
          tenantId,
          itemId,
          outstanding,
          row.ordered_uom,
          itemConfig.canonicalUom
        );
      } catch {
        continue;
      }
    }

    const current = map.get(itemConfig.canonicalUom) ?? 0;
    map.set(itemConfig.canonicalUom, roundQuantity(current + canonicalQty));
  }
  return map;
}

async function loadInTransitCanonical(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom?: string
): Promise<Map<string, number>> {
  const itemConfig = await getItemUomConfigIfPresent(tenantId, itemId);
  if (!itemConfig) {
    return new Map();
  }
  if (uom && !isSameUom(uom, itemConfig.canonicalUom)) {
    return new Map();
  }

  const params: any[] = [tenantId, itemId, locationId];
  const { rows } = await query<{ id: string }>(
    `SELECT prl.id
       FROM purchase_order_receipt_lines prl
       JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id
       JOIN purchase_order_receipts por ON por.id = prl.purchase_order_receipt_id
       JOIN purchase_orders po ON po.id = pol.purchase_order_id
      WHERE prl.tenant_id = $1
        AND pol.tenant_id = $1
        AND por.tenant_id = $1
        AND po.tenant_id = $1
        AND pol.item_id = $2
        AND COALESCE(por.received_to_location_id, po.ship_to_location_id) = $3`,
    params
  );

  const lineIds = rows.map((row) => row.id);
  if (lineIds.length === 0) {
    return new Map();
  }

  const contexts = await loadReceiptLineContexts(tenantId, lineIds);
  const qcBreakdown = await loadQcBreakdown(tenantId, lineIds);
  const putawayTotals = await loadPutawayTotals(tenantId, lineIds);

  const map = new Map<string, number>();

  for (const lineId of lineIds) {
    const context = contexts.get(lineId);
    if (!context) continue;
    const qc = qcBreakdown.get(lineId) ?? { hold: 0, accept: 0, reject: 0 };
    const totals = putawayTotals.get(lineId) ?? { posted: 0, pending: 0 };

    const accepted = normalizeQuantity(calculateAcceptedQuantity(context.quantityReceived, qc));
    const posted = normalizeQuantity(totals.posted ?? 0);
    const remaining = roundQuantity(Math.max(0, accepted - posted));

    if (remaining <= 0) continue;
    let canonicalQty = remaining;
    if (!isSameUom(context.uom, itemConfig.canonicalUom)) {
      try {
        canonicalQty = await convertQuantity(
          tenantId,
          itemId,
          remaining,
          context.uom,
          itemConfig.canonicalUom
        );
      } catch {
        continue;
      }
    }
    const current = map.get(itemConfig.canonicalUom) ?? 0;
    map.set(itemConfig.canonicalUom, roundQuantity(current + canonicalQty));
  }

  return map;
}

async function loadOnOrder(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom?: string
): Promise<Map<string, number>> {
  const params: any[] = [tenantId, itemId, locationId];
  const uomFilter = uom ? ` AND pol.uom = $${params.push(uom)}` : '';
  const { rows } = await query(
    `SELECT
        pol.uom,
        SUM(pol.quantity_ordered) AS total_ordered,
        SUM(COALESCE(rec.total_received, 0)) AS total_received
       FROM purchase_order_lines pol
       JOIN purchase_orders po ON po.id = pol.purchase_order_id
       LEFT JOIN (
         SELECT purchase_order_line_id, SUM(quantity_received) AS total_received
           FROM purchase_order_receipt_lines
          GROUP BY purchase_order_line_id
       ) rec ON rec.purchase_order_line_id = pol.id
      WHERE pol.tenant_id = $1
        AND po.tenant_id = $1
        AND pol.item_id = $2
        AND po.ship_to_location_id = $3
        AND po.status IN ('approved','partially_received')${uomFilter}
      GROUP BY pol.uom`,
    params
  );

  const map = new Map<string, number>();
  rows.forEach((row: any) => {
    const ordered = normalizeQuantity(row.total_ordered);
    const received = normalizeQuantity(row.total_received);
    const outstanding = roundQuantity(Math.max(0, ordered - received));
    map.set(row.uom, outstanding);
  });
  return map;
}

async function loadInTransit(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom?: string
): Promise<Map<string, number>> {
  // Best available proxy: receipt lines for this item + location where accepted quantity
  // has not yet been posted via putaway/completed movements.
  const params: any[] = [tenantId, itemId, locationId];
  const uomFilter = uom ? ` AND prl.uom = $${params.push(uom)}` : '';
  const { rows } = await query<{ id: string }>(
    `SELECT prl.id
       FROM purchase_order_receipt_lines prl
       JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id
       JOIN purchase_order_receipts por ON por.id = prl.purchase_order_receipt_id
       JOIN purchase_orders po ON po.id = pol.purchase_order_id
      WHERE prl.tenant_id = $1
        AND pol.tenant_id = $1
        AND por.tenant_id = $1
        AND po.tenant_id = $1
        AND pol.item_id = $2
        AND COALESCE(por.received_to_location_id, po.ship_to_location_id) = $3${uomFilter}`,
    params
  );

  const lineIds = rows.map((row) => row.id);
  if (lineIds.length === 0) {
    return new Map();
  }

  const contexts = await loadReceiptLineContexts(tenantId, lineIds);
  const qcBreakdown = await loadQcBreakdown(tenantId, lineIds);
  const putawayTotals = await loadPutawayTotals(tenantId, lineIds);

  const map = new Map<string, number>();

  for (const lineId of lineIds) {
    const context = contexts.get(lineId);
    if (!context) continue;
    const qc = qcBreakdown.get(lineId) ?? { hold: 0, accept: 0, reject: 0 };
    const totals = putawayTotals.get(lineId) ?? { posted: 0, pending: 0 };

    const accepted = normalizeQuantity(calculateAcceptedQuantity(context.quantityReceived, qc));
    const posted = normalizeQuantity(totals.posted ?? 0);
    const remaining = roundQuantity(Math.max(0, accepted - posted));

    if (remaining <= 0) continue;
    const current = map.get(context.uom) ?? 0;
    map.set(context.uom, roundQuantity(current + remaining));
  }

  return map;
}

async function loadQcBuckets(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom?: string
): Promise<Map<string, { held: number; rejected: number }>> {
  const params: any[] = [tenantId, itemId, locationId];
  const uomFilter = uom ? ` AND prl.uom = $${params.push(uom)}` : '';
  const { rows } = await query(
    `SELECT prl.uom,
            SUM(CASE WHEN qe.event_type = 'hold' THEN qe.quantity ELSE 0 END) AS held_qty,
            SUM(CASE WHEN qe.event_type = 'reject' THEN qe.quantity ELSE 0 END) AS rejected_qty
       FROM qc_events qe
       JOIN purchase_order_receipt_lines prl ON prl.id = qe.purchase_order_receipt_line_id AND prl.tenant_id = qe.tenant_id
       JOIN purchase_order_receipts por ON por.id = prl.purchase_order_receipt_id AND por.tenant_id = prl.tenant_id
       JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id AND pol.tenant_id = prl.tenant_id
       JOIN purchase_orders po ON po.id = pol.purchase_order_id AND po.tenant_id = pol.tenant_id
      WHERE qe.tenant_id = $1
        AND pol.item_id = $2
        AND COALESCE(por.received_to_location_id, po.ship_to_location_id) = $3
        AND por.status <> 'voided'${uomFilter}
      GROUP BY prl.uom`,
    params
  );

  const map = new Map<string, { held: number; rejected: number }>();
  rows.forEach((row: any) => {
    map.set(row.uom, {
      held: normalizeQuantity(row.held_qty),
      rejected: normalizeQuantity(row.rejected_qty)
    });
  });
  return map;
}

export async function getInventorySnapshot(
  tenantId: string,
  params: InventorySnapshotParams
): Promise<InventorySnapshotRow[]> {
  const { itemId, locationId, uom } = params;

  const backordersEnabled = await hasBackordersTable();
  const [canonicalOnHand, canonicalReserved, canonicalOnOrder, canonicalInTransit, canonicalBackordered] =
    await Promise.all([
      loadOnHand(tenantId, itemId, locationId, uom, 'canonical'),
      loadReserved(tenantId, itemId, locationId, uom, 'canonical'),
      loadOnOrderCanonical(tenantId, itemId, locationId, uom),
      loadInTransitCanonical(tenantId, itemId, locationId, uom),
      backordersEnabled ? loadBackordered(tenantId, itemId, locationId, uom, 'canonical') : new Map()
    ]);
  const hasCanonical =
    canonicalOnHand.size > 0 ||
    canonicalReserved.size > 0 ||
    canonicalOnOrder.size > 0 ||
    canonicalInTransit.size > 0 ||
    canonicalBackordered.size > 0;

  let onHandMap = canonicalOnHand;
  let reservedMap = canonicalReserved;
  let onOrderMap = canonicalOnOrder;
  let inTransitMap = canonicalInTransit;
  let qcBucketsMap = new Map<string, { held: number; rejected: number }>();
  let backorderedMap = canonicalBackordered;

  if (!hasCanonical) {
    [onHandMap, reservedMap, onOrderMap, inTransitMap, backorderedMap] = await Promise.all([
      loadOnHand(tenantId, itemId, locationId, uom, 'legacy'),
      loadReserved(tenantId, itemId, locationId, uom, 'legacy'),
      loadOnOrder(tenantId, itemId, locationId, uom),
      loadInTransit(tenantId, itemId, locationId, uom),
      backordersEnabled ? loadBackordered(tenantId, itemId, locationId, uom, 'legacy') : new Map()
    ]);
    qcBucketsMap = await loadQcBuckets(tenantId, itemId, locationId, uom);
  }

  const uoms = new Set<string>();
  onHandMap.forEach((_v, key) => uoms.add(key));
  reservedMap.forEach((_v, key) => uoms.add(key));
  onOrderMap.forEach((_v, key) => uoms.add(key));
  inTransitMap.forEach((_v, key) => uoms.add(key));
  qcBucketsMap.forEach((_v, key) => uoms.add(key));
  backorderedMap.forEach((_v, key) => uoms.add(key));
  if (uom) {
    uoms.add(uom);
  }

  const rows: InventorySnapshotRow[] = [];
  Array.from(uoms)
    .sort((a, b) => a.localeCompare(b))
    .forEach((entryUom) => {
      const onHand = onHandMap.get(entryUom) ?? 0;
      const reserved = reservedMap.get(entryUom) ?? 0;
      const onOrder = onOrderMap.get(entryUom) ?? 0;
      const inTransit = inTransitMap.get(entryUom) ?? 0;
      const qcBuckets = qcBucketsMap.get(entryUom) ?? { held: 0, rejected: 0 };
      const held = qcBuckets.held ?? 0;
      const rejected = qcBuckets.rejected ?? 0;
      const nonUsable = roundQuantity(held + rejected);
      const backordered = backorderedMap.get(entryUom) ?? 0;

      const available = roundQuantity(onHand - reserved);
      const inventoryPosition = roundQuantity(onHand + onOrder - backordered);

      rows.push({
        itemId,
        locationId,
        uom: entryUom,
        onHand,
        reserved,
        available,
        held,
        rejected,
        nonUsable,
        onOrder,
        inTransit,
        backordered,
        inventoryPosition,
        isLegacy: !hasCanonical
      });
    });

  return rows;
}

export { assertItemExists, assertLocationExists };

export async function getInventorySnapshotSummary(
  tenantId: string,
  params: InventorySnapshotSummaryParams = {}
): Promise<InventorySnapshotRow[]> {
  const backordersEnabled = await hasBackordersTable();
  const clauses: string[] = [];
  const reservedClauses: string[] = [];
  const qcClauses: string[] = [];
  const backorderClauses: string[] = [];
  const onOrderClauses: string[] = [];
  const paramsList: any[] = [tenantId];

  if (params.itemId) {
    clauses.push(`iml.item_id = $${paramsList.push(params.itemId)}`);
    reservedClauses.push(`r.item_id = $${paramsList.length}`);
    qcClauses.push(`pol.item_id = $${paramsList.length}`);
    backorderClauses.push(`b.item_id = $${paramsList.length}`);
    onOrderClauses.push(`pol.item_id = $${paramsList.length}`);
  }
  if (params.locationId) {
    clauses.push(`iml.location_id = $${paramsList.push(params.locationId)}`);
    reservedClauses.push(`r.location_id = $${paramsList.length}`);
    qcClauses.push(`COALESCE(por.received_to_location_id, po.ship_to_location_id) = $${paramsList.length}`);
    backorderClauses.push(`b.location_id = $${paramsList.length}`);
    onOrderClauses.push(`po.ship_to_location_id = $${paramsList.length}`);
  }

  const limit = params.limit ?? 500;
  const offset = params.offset ?? 0;

  const whereOnHand = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  const whereReserved = reservedClauses.length ? `AND ${reservedClauses.join(' AND ')}` : '';
  const whereQc = qcClauses.length ? `AND ${qcClauses.join(' AND ')}` : '';
  const whereBackordered = backorderClauses.length ? `AND ${backorderClauses.join(' AND ')}` : '';
  const whereOnOrder = onOrderClauses.length ? `AND ${onOrderClauses.join(' AND ')}` : '';

  const limitParam = paramsList.push(limit);
  const offsetParam = paramsList.push(offset);

  let canonicalRows = (await query(
    `WITH uom_to_canonical AS (
       SELECT tenant_id,
              item_id,
              LOWER(from_uom) AS from_uom,
              LOWER(to_uom) AS to_uom,
              factor
         FROM uom_conversions
        UNION ALL
       SELECT tenant_id,
              item_id,
              LOWER(to_uom) AS from_uom,
              LOWER(from_uom) AS to_uom,
              1 / factor AS factor
         FROM uom_conversions
     ),
     on_hand AS (
       SELECT iml.item_id,
              iml.location_id,
              iml.canonical_uom AS uom,
              SUM(iml.quantity_delta_canonical) AS on_hand
         FROM inventory_movement_lines iml
         JOIN inventory_movements im ON im.id = iml.movement_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          AND iml.quantity_delta_canonical IS NOT NULL
          ${whereOnHand}
        GROUP BY iml.item_id, iml.location_id, iml.canonical_uom
     ),
     reserved AS (
       SELECT r.item_id,
              r.location_id,
              i.canonical_uom AS uom,
              SUM(r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0)) AS reserved
         FROM inventory_reservations r
         JOIN items i ON i.id = r.item_id AND i.tenant_id = r.tenant_id
        WHERE r.status IN ('open', 'released')
          AND r.tenant_id = $1
          AND i.canonical_uom IS NOT NULL
          AND r.uom = i.canonical_uom
          ${whereReserved}
        GROUP BY r.item_id, r.location_id, i.canonical_uom
     ),
     on_order AS (
       SELECT pol.item_id,
              po.ship_to_location_id AS location_id,
              i.canonical_uom AS uom,
              SUM(
                CASE
                  WHEN LOWER(pol.uom) = LOWER(i.canonical_uom) THEN pol.quantity_ordered
                  WHEN conv.factor IS NOT NULL THEN pol.quantity_ordered * conv.factor
                  ELSE 0
                END
              ) AS total_ordered,
              SUM(
                CASE
                  WHEN LOWER(pol.uom) = LOWER(i.canonical_uom) THEN COALESCE(rec.total_received, 0)
                  WHEN conv.factor IS NOT NULL THEN COALESCE(rec.total_received, 0) * conv.factor
                  ELSE 0
                END
              ) AS total_received
         FROM purchase_order_lines pol
         JOIN purchase_orders po ON po.id = pol.purchase_order_id
         JOIN items i ON i.id = pol.item_id AND i.tenant_id = pol.tenant_id
         LEFT JOIN uom_to_canonical conv
           ON conv.tenant_id = pol.tenant_id
          AND conv.item_id = pol.item_id
          AND conv.from_uom = LOWER(pol.uom)
          AND conv.to_uom = LOWER(i.canonical_uom)
         LEFT JOIN (
           SELECT purchase_order_line_id, SUM(quantity_received) AS total_received
             FROM purchase_order_receipt_lines
            GROUP BY purchase_order_line_id
         ) rec ON rec.purchase_order_line_id = pol.id
        WHERE pol.tenant_id = $1
          AND po.tenant_id = $1
          AND po.status IN ('approved','partially_received')
          AND i.canonical_uom IS NOT NULL
          ${whereOnOrder}
        GROUP BY pol.item_id, po.ship_to_location_id, i.canonical_uom
     ),
     combined AS (
       SELECT item_id,
              location_id,
              uom,
              SUM(on_hand) AS on_hand,
              SUM(reserved) AS reserved,
              SUM(on_order) AS on_order
         FROM (
           SELECT item_id, location_id, uom, on_hand, 0 AS reserved, 0 AS backordered, 0 AS on_order FROM on_hand
           UNION ALL
           SELECT item_id, location_id, uom, 0 AS on_hand, reserved, 0 AS backordered, 0 AS on_order FROM reserved
           UNION ALL
           SELECT item_id, location_id, uom, 0 AS on_hand, 0 AS reserved, 0 AS backordered,
                  GREATEST(0, total_ordered - total_received) AS on_order
             FROM on_order
         ) sums
        GROUP BY item_id, location_id, uom
     )
    SELECT combined.item_id,
           combined.location_id,
           combined.uom,
           combined.on_hand,
           combined.reserved,
           (combined.on_hand - combined.reserved) AS available,
           0 AS held,
           0 AS rejected,
           0 AS non_usable,
           combined.on_order AS on_order,
           0 AS in_transit,
           0 AS backordered,
           (combined.on_hand + combined.on_order) AS inventory_position,
           false AS is_legacy
      FROM combined
     WHERE combined.on_hand <> 0
        OR combined.reserved <> 0
        OR combined.on_order <> 0
     ORDER BY item_id, location_id, uom
     LIMIT $${limitParam} OFFSET $${offsetParam};`,
    paramsList
  )).rows;

  if (backordersEnabled) {
    canonicalRows = (await query(
      `WITH uom_to_canonical AS (
           SELECT tenant_id,
                  item_id,
                  LOWER(from_uom) AS from_uom,
                  LOWER(to_uom) AS to_uom,
                  factor
             FROM uom_conversions
            UNION ALL
           SELECT tenant_id,
                  item_id,
                  LOWER(to_uom) AS from_uom,
                  LOWER(from_uom) AS to_uom,
                  1 / factor AS factor
             FROM uom_conversions
         ),
         on_hand AS (
           SELECT iml.item_id,
                  iml.location_id,
                  iml.canonical_uom AS uom,
                  SUM(iml.quantity_delta_canonical) AS on_hand
             FROM inventory_movement_lines iml
             JOIN inventory_movements im ON im.id = iml.movement_id
            WHERE im.status = 'posted'
              AND iml.tenant_id = $1
              AND im.tenant_id = $1
              AND iml.quantity_delta_canonical IS NOT NULL
              ${whereOnHand}
            GROUP BY iml.item_id, iml.location_id, iml.canonical_uom
         ),
         reserved AS (
           SELECT r.item_id,
                  r.location_id,
                  i.canonical_uom AS uom,
                  SUM(r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0)) AS reserved
             FROM inventory_reservations r
             JOIN items i ON i.id = r.item_id AND i.tenant_id = r.tenant_id
            WHERE r.status IN ('open', 'released')
              AND r.tenant_id = $1
              AND i.canonical_uom IS NOT NULL
              AND r.uom = i.canonical_uom
              ${whereReserved}
            GROUP BY r.item_id, r.location_id, i.canonical_uom
         ),
         backordered AS (
           SELECT b.item_id,
                  b.location_id,
                  i.canonical_uom AS uom,
                  SUM(b.quantity_backordered) AS backordered
             FROM inventory_backorders b
             JOIN items i ON i.id = b.item_id AND i.tenant_id = b.tenant_id
            WHERE b.status = 'open'
              AND b.tenant_id = $1
              AND i.canonical_uom IS NOT NULL
              AND b.uom = i.canonical_uom
              ${whereBackordered}
            GROUP BY b.item_id, b.location_id, i.canonical_uom
         ),
         on_order AS (
           SELECT pol.item_id,
                  po.ship_to_location_id AS location_id,
                  i.canonical_uom AS uom,
                  SUM(
                    CASE
                      WHEN LOWER(pol.uom) = LOWER(i.canonical_uom) THEN pol.quantity_ordered
                      WHEN conv.factor IS NOT NULL THEN pol.quantity_ordered * conv.factor
                      ELSE 0
                    END
                  ) AS total_ordered,
                  SUM(
                    CASE
                      WHEN LOWER(pol.uom) = LOWER(i.canonical_uom) THEN COALESCE(rec.total_received, 0)
                      WHEN conv.factor IS NOT NULL THEN COALESCE(rec.total_received, 0) * conv.factor
                      ELSE 0
                    END
                  ) AS total_received
             FROM purchase_order_lines pol
             JOIN purchase_orders po ON po.id = pol.purchase_order_id
             JOIN items i ON i.id = pol.item_id AND i.tenant_id = pol.tenant_id
             LEFT JOIN uom_to_canonical conv
               ON conv.tenant_id = pol.tenant_id
              AND conv.item_id = pol.item_id
              AND conv.from_uom = LOWER(pol.uom)
              AND conv.to_uom = LOWER(i.canonical_uom)
             LEFT JOIN (
               SELECT purchase_order_line_id, SUM(quantity_received) AS total_received
                 FROM purchase_order_receipt_lines
                GROUP BY purchase_order_line_id
             ) rec ON rec.purchase_order_line_id = pol.id
            WHERE pol.tenant_id = $1
              AND po.tenant_id = $1
              AND po.status IN ('approved','partially_received')
              AND i.canonical_uom IS NOT NULL
              ${whereOnOrder}
            GROUP BY pol.item_id, po.ship_to_location_id, i.canonical_uom
         ),
         combined AS (
           SELECT item_id,
                  location_id,
                  uom,
                  SUM(on_hand) AS on_hand,
                  SUM(reserved) AS reserved,
                  SUM(backordered) AS backordered,
                  SUM(on_order) AS on_order
             FROM (
               SELECT item_id, location_id, uom, on_hand, 0 AS reserved, 0 AS backordered, 0 AS on_order FROM on_hand
               UNION ALL
               SELECT item_id, location_id, uom, 0 AS on_hand, reserved, 0 AS backordered, 0 AS on_order FROM reserved
               UNION ALL
               SELECT item_id, location_id, uom, 0 AS on_hand, 0 AS reserved, backordered, 0 AS on_order FROM backordered
               UNION ALL
               SELECT item_id, location_id, uom, 0 AS on_hand, 0 AS reserved, 0 AS backordered,
                      GREATEST(0, total_ordered - total_received) AS on_order
                 FROM on_order
             ) sums
            GROUP BY item_id, location_id, uom
         )
        SELECT combined.item_id,
               combined.location_id,
               combined.uom,
               combined.on_hand,
               combined.reserved,
               (combined.on_hand - combined.reserved) AS available,
               0 AS held,
               0 AS rejected,
               0 AS non_usable,
               combined.on_order AS on_order,
               0 AS in_transit,
               combined.backordered AS backordered,
               (combined.on_hand + combined.on_order - combined.backordered) AS inventory_position,
               false AS is_legacy
          FROM combined
         WHERE combined.on_hand <> 0
            OR combined.reserved <> 0
            OR combined.backordered <> 0
            OR combined.on_order <> 0
         ORDER BY item_id, location_id, uom
         LIMIT $${limitParam} OFFSET $${offsetParam};`,
      paramsList
    )).rows;
  }

  const canonicalKeys = new Set(
    canonicalRows.map((row: any) => `${row.item_id}:${row.location_id}`)
  );

  const legacyQuery = backordersEnabled
    ? `WITH on_hand AS (
       SELECT iml.item_id,
              iml.location_id,
              iml.uom,
              SUM(iml.quantity_delta) AS on_hand
         FROM inventory_movement_lines iml
         JOIN inventory_movements im ON im.id = iml.movement_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          AND iml.quantity_delta_canonical IS NULL
          ${whereOnHand}
        GROUP BY iml.item_id, iml.location_id, iml.uom
     ),
     reserved AS (
       SELECT r.item_id,
              r.location_id,
              r.uom,
              SUM(r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0)) AS reserved
         FROM inventory_reservations r
        WHERE r.status IN ('open', 'released')
          AND r.tenant_id = $1
          ${whereReserved}
        GROUP BY r.item_id, r.location_id, r.uom
     ),
     backordered AS (
       SELECT b.item_id,
              b.location_id,
              b.uom,
              SUM(b.quantity_backordered) AS backordered
         FROM inventory_backorders b
        WHERE b.status = 'open'
          AND b.tenant_id = $1
          ${whereBackordered}
        GROUP BY b.item_id, b.location_id, b.uom
     ),
     on_order AS (
       SELECT pol.item_id,
              po.ship_to_location_id AS location_id,
              pol.uom,
              SUM(pol.quantity_ordered) AS total_ordered,
              SUM(COALESCE(rec.total_received, 0)) AS total_received
         FROM purchase_order_lines pol
         JOIN purchase_orders po ON po.id = pol.purchase_order_id
         LEFT JOIN (
           SELECT purchase_order_line_id, SUM(quantity_received) AS total_received
             FROM purchase_order_receipt_lines
            GROUP BY purchase_order_line_id
         ) rec ON rec.purchase_order_line_id = pol.id
        WHERE pol.tenant_id = $1
          AND po.tenant_id = $1
          AND po.status IN ('approved','partially_received')
          ${whereOnOrder}
        GROUP BY pol.item_id, po.ship_to_location_id, pol.uom
     ),
     qc_buckets AS (
       SELECT pol.item_id,
              COALESCE(por.received_to_location_id, po.ship_to_location_id) AS location_id,
              prl.uom,
              SUM(CASE WHEN qe.event_type = 'hold' THEN qe.quantity ELSE 0 END) AS held_qty,
              SUM(CASE WHEN qe.event_type = 'reject' THEN qe.quantity ELSE 0 END) AS rejected_qty
         FROM qc_events qe
         JOIN purchase_order_receipt_lines prl
           ON prl.id = qe.purchase_order_receipt_line_id
          AND prl.tenant_id = qe.tenant_id
         JOIN purchase_order_receipts por
           ON por.id = prl.purchase_order_receipt_id
          AND por.tenant_id = prl.tenant_id
         JOIN purchase_order_lines pol
           ON pol.id = prl.purchase_order_line_id
          AND pol.tenant_id = prl.tenant_id
         JOIN purchase_orders po
           ON po.id = pol.purchase_order_id
          AND po.tenant_id = pol.tenant_id
        WHERE qe.tenant_id = $1
          AND por.status <> 'voided'
          ${whereQc}
        GROUP BY pol.item_id, COALESCE(por.received_to_location_id, po.ship_to_location_id), prl.uom
     ),
     combined AS (
       SELECT item_id,
              location_id,
              uom,
              SUM(on_hand) AS on_hand,
              SUM(reserved) AS reserved,
              SUM(backordered) AS backordered,
              SUM(on_order) AS on_order
         FROM (
           SELECT item_id, location_id, uom, on_hand, 0 AS reserved, 0 AS backordered, 0 AS on_order FROM on_hand
           UNION ALL
           SELECT item_id, location_id, uom, 0 AS on_hand, reserved, 0 AS backordered, 0 AS on_order FROM reserved
           UNION ALL
           SELECT item_id, location_id, uom, 0 AS on_hand, 0 AS reserved, backordered, 0 AS on_order FROM backordered
           UNION ALL
           SELECT item_id, location_id, uom, 0 AS on_hand, 0 AS reserved, 0 AS backordered,
                  GREATEST(0, total_ordered - total_received) AS on_order
             FROM on_order
         ) sums
        GROUP BY item_id, location_id, uom
     )
    SELECT combined.item_id,
           combined.location_id,
           combined.uom,
           combined.on_hand,
           combined.reserved,
           (combined.on_hand - combined.reserved) AS available,
           COALESCE(qc.held_qty, 0) AS held,
           COALESCE(qc.rejected_qty, 0) AS rejected,
           (COALESCE(qc.held_qty, 0) + COALESCE(qc.rejected_qty, 0)) AS non_usable,
           combined.on_order AS on_order,
           0 AS in_transit,
           combined.backordered AS backordered,
           (combined.on_hand + combined.on_order - combined.backordered) AS inventory_position,
           true AS is_legacy
      FROM combined
      LEFT JOIN qc_buckets qc
        ON qc.item_id = combined.item_id
       AND qc.location_id = combined.location_id
       AND qc.uom = combined.uom
     WHERE combined.on_hand <> 0
        OR combined.reserved <> 0
        OR combined.backordered <> 0
        OR combined.on_order <> 0
        OR COALESCE(qc.held_qty, 0) <> 0
        OR COALESCE(qc.rejected_qty, 0) <> 0
     ORDER BY item_id, location_id, uom
     LIMIT $${limitParam} OFFSET $${offsetParam};`
    : `WITH on_hand AS (
       SELECT iml.item_id,
              iml.location_id,
              iml.uom,
              SUM(iml.quantity_delta) AS on_hand
         FROM inventory_movement_lines iml
         JOIN inventory_movements im ON im.id = iml.movement_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          AND iml.quantity_delta_canonical IS NULL
          ${whereOnHand}
        GROUP BY iml.item_id, iml.location_id, iml.uom
     ),
     reserved AS (
       SELECT r.item_id,
              r.location_id,
              r.uom,
              SUM(r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0)) AS reserved
         FROM inventory_reservations r
        WHERE r.status IN ('open', 'released')
          AND r.tenant_id = $1
          ${whereReserved}
        GROUP BY r.item_id, r.location_id, r.uom
     ),
     on_order AS (
       SELECT pol.item_id,
              po.ship_to_location_id AS location_id,
              pol.uom,
              SUM(pol.quantity_ordered) AS total_ordered,
              SUM(COALESCE(rec.total_received, 0)) AS total_received
         FROM purchase_order_lines pol
         JOIN purchase_orders po ON po.id = pol.purchase_order_id
         LEFT JOIN (
           SELECT purchase_order_line_id, SUM(quantity_received) AS total_received
             FROM purchase_order_receipt_lines
            GROUP BY purchase_order_line_id
         ) rec ON rec.purchase_order_line_id = pol.id
        WHERE pol.tenant_id = $1
          AND po.tenant_id = $1
          AND po.status IN ('approved','partially_received')
          ${whereOnOrder}
        GROUP BY pol.item_id, po.ship_to_location_id, pol.uom
     ),
     qc_buckets AS (
       SELECT pol.item_id,
              COALESCE(por.received_to_location_id, po.ship_to_location_id) AS location_id,
              prl.uom,
              SUM(CASE WHEN qe.event_type = 'hold' THEN qe.quantity ELSE 0 END) AS held_qty,
              SUM(CASE WHEN qe.event_type = 'reject' THEN qe.quantity ELSE 0 END) AS rejected_qty
         FROM qc_events qe
         JOIN purchase_order_receipt_lines prl
           ON prl.id = qe.purchase_order_receipt_line_id
          AND prl.tenant_id = qe.tenant_id
         JOIN purchase_order_receipts por
           ON por.id = prl.purchase_order_receipt_id
          AND por.tenant_id = prl.tenant_id
         JOIN purchase_order_lines pol
           ON pol.id = prl.purchase_order_line_id
          AND pol.tenant_id = prl.tenant_id
         JOIN purchase_orders po
           ON po.id = pol.purchase_order_id
          AND po.tenant_id = pol.tenant_id
        WHERE qe.tenant_id = $1
          AND por.status <> 'voided'
          ${whereQc}
        GROUP BY pol.item_id, COALESCE(por.received_to_location_id, po.ship_to_location_id), prl.uom
     ),
     combined AS (
       SELECT item_id,
              location_id,
              uom,
              SUM(on_hand) AS on_hand,
              SUM(reserved) AS reserved,
              SUM(on_order) AS on_order
         FROM (
           SELECT item_id, location_id, uom, on_hand, 0 AS reserved, 0 AS backordered, 0 AS on_order FROM on_hand
           UNION ALL
           SELECT item_id, location_id, uom, 0 AS on_hand, reserved, 0 AS backordered, 0 AS on_order FROM reserved
           UNION ALL
           SELECT item_id, location_id, uom, 0 AS on_hand, 0 AS reserved, 0 AS backordered,
                  GREATEST(0, total_ordered - total_received) AS on_order
             FROM on_order
         ) sums
        GROUP BY item_id, location_id, uom
     )
    SELECT combined.item_id,
           combined.location_id,
           combined.uom,
           combined.on_hand,
           combined.reserved,
           (combined.on_hand - combined.reserved) AS available,
           COALESCE(qc.held_qty, 0) AS held,
           COALESCE(qc.rejected_qty, 0) AS rejected,
           (COALESCE(qc.held_qty, 0) + COALESCE(qc.rejected_qty, 0)) AS non_usable,
           combined.on_order AS on_order,
           0 AS in_transit,
           0 AS backordered,
           (combined.on_hand + combined.on_order) AS inventory_position,
           true AS is_legacy
      FROM combined
      LEFT JOIN qc_buckets qc
        ON qc.item_id = combined.item_id
       AND qc.location_id = combined.location_id
       AND qc.uom = combined.uom
     WHERE combined.on_hand <> 0
        OR combined.reserved <> 0
        OR combined.on_order <> 0
        OR COALESCE(qc.held_qty, 0) <> 0
        OR COALESCE(qc.rejected_qty, 0) <> 0
     ORDER BY item_id, location_id, uom
     LIMIT $${limitParam} OFFSET $${offsetParam};`;

  const { rows } = await query(legacyQuery, paramsList);

  const legacyRows = rows
    .map((row: any) => ({
      itemId: row.item_id,
      locationId: row.location_id,
      uom: row.uom,
      onHand: normalizeQuantity(row.on_hand),
      reserved: normalizeQuantity(row.reserved),
      available: normalizeQuantity(row.available),
      held: normalizeQuantity(row.held),
      rejected: normalizeQuantity(row.rejected),
      nonUsable: normalizeQuantity(row.non_usable),
      onOrder: normalizeQuantity(row.on_order),
      inTransit: normalizeQuantity(row.in_transit),
      backordered: normalizeQuantity(row.backordered),
      inventoryPosition: normalizeQuantity(row.inventory_position),
      isLegacy: row.is_legacy
    }))
    .filter((row) => !canonicalKeys.has(`${row.itemId}:${row.locationId}`));

  const canonicalMapped = canonicalRows.map((row: any) => ({
    itemId: row.item_id,
    locationId: row.location_id,
    uom: row.uom,
    onHand: normalizeQuantity(row.on_hand),
    reserved: normalizeQuantity(row.reserved),
    available: normalizeQuantity(row.available),
    held: normalizeQuantity(row.held),
    rejected: normalizeQuantity(row.rejected),
    nonUsable: normalizeQuantity(row.non_usable),
    onOrder: normalizeQuantity(row.on_order),
    inTransit: normalizeQuantity(row.in_transit),
    backordered: normalizeQuantity(row.backordered),
    inventoryPosition: normalizeQuantity(row.inventory_position),
    isLegacy: row.is_legacy
  }));

  return [...canonicalMapped, ...legacyRows];
}
