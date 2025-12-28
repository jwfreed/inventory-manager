import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { assertItemExists, assertLocationExists } from './inventorySummary.service';
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

async function loadOnHand(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom?: string
): Promise<Map<string, number>> {
  const params: any[] = [tenantId, itemId, locationId];
  const uomFilter = uom ? ` AND iml.uom = $${params.push(uom)}` : '';
  const { rows } = await query(
    `SELECT iml.uom, SUM(iml.quantity_delta) AS on_hand
       FROM inventory_movement_lines iml
       JOIN inventory_movements im ON im.id = iml.movement_id
      WHERE im.status = 'posted'
        AND iml.tenant_id = $1
        AND im.tenant_id = $1
        AND iml.item_id = $2
        AND iml.location_id = $3${uomFilter}
      GROUP BY iml.uom`,
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
  uom?: string
): Promise<Map<string, number>> {
  const params: any[] = [tenantId, itemId, locationId];
  const uomFilter = uom ? ` AND r.uom = $${params.push(uom)}` : '';
  const { rows } = await query(
    `SELECT r.uom, SUM(r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0)) AS reserved_qty
       FROM inventory_reservations r
      WHERE r.tenant_id = $1
        AND r.item_id = $2
        AND r.location_id = $3
        AND r.status IN ('open', 'released')${uomFilter}
      GROUP BY r.uom`,
    params
  );

  const map = new Map<string, number>();
  rows.forEach((row: any) => {
    const remaining = roundQuantity(Math.max(0, normalizeQuantity(row.reserved_qty)));
    map.set(row.uom, remaining);
  });
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

  const [onHandMap, reservedMap, onOrderMap, inTransitMap] = await Promise.all([
    loadOnHand(tenantId, itemId, locationId, uom),
    loadReserved(tenantId, itemId, locationId, uom),
    loadOnOrder(tenantId, itemId, locationId, uom),
    loadInTransit(tenantId, itemId, locationId, uom)
  ]);
  const qcBucketsMap = await loadQcBuckets(tenantId, itemId, locationId, uom);

  const uoms = new Set<string>();
  onHandMap.forEach((_v, key) => uoms.add(key));
  reservedMap.forEach((_v, key) => uoms.add(key));
  onOrderMap.forEach((_v, key) => uoms.add(key));
  inTransitMap.forEach((_v, key) => uoms.add(key));
  qcBucketsMap.forEach((_v, key) => uoms.add(key));
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
      const backordered = 0;

      const available = roundQuantity(onHand - reserved);
      const inventoryPosition = roundQuantity(onHand + onOrder + inTransit - reserved - backordered);

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
        inventoryPosition
      });
    });

  return rows;
}

export { assertItemExists, assertLocationExists };

export async function getInventorySnapshotSummary(
  tenantId: string,
  params: InventorySnapshotSummaryParams = {}
): Promise<InventorySnapshotRow[]> {
  const clauses: string[] = [];
  const reservedClauses: string[] = [];
  const qcClauses: string[] = [];
  const paramsList: any[] = [tenantId];

  if (params.itemId) {
    clauses.push(`iml.item_id = $${paramsList.push(params.itemId)}`);
    reservedClauses.push(`r.item_id = $${paramsList.length}`);
    qcClauses.push(`pol.item_id = $${paramsList.length}`);
  }
  if (params.locationId) {
    clauses.push(`iml.location_id = $${paramsList.push(params.locationId)}`);
    reservedClauses.push(`r.location_id = $${paramsList.length}`);
    qcClauses.push(`COALESCE(por.received_to_location_id, po.ship_to_location_id) = $${paramsList.length}`);
  }

  const limit = params.limit ?? 500;
  const offset = params.offset ?? 0;

  const whereOnHand = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  const whereReserved = reservedClauses.length ? `AND ${reservedClauses.join(' AND ')}` : '';
  const whereQc = qcClauses.length ? `AND ${qcClauses.join(' AND ')}` : '';

  const { rows } = await query(
    `WITH on_hand AS (
       SELECT iml.item_id,
              iml.location_id,
              iml.uom,
              SUM(iml.quantity_delta) AS on_hand
         FROM inventory_movement_lines iml
         JOIN inventory_movements im ON im.id = iml.movement_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
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
       SELECT COALESCE(oh.item_id, rs.item_id) AS item_id,
              COALESCE(oh.location_id, rs.location_id) AS location_id,
              COALESCE(oh.uom, rs.uom) AS uom,
              COALESCE(oh.on_hand, 0) AS on_hand,
              COALESCE(rs.reserved, 0) AS reserved
         FROM on_hand oh
         FULL OUTER JOIN reserved rs
           ON oh.item_id = rs.item_id
          AND oh.location_id = rs.location_id
          AND oh.uom = rs.uom
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
           0 AS on_order,
           0 AS in_transit,
           0 AS backordered,
           (combined.on_hand - combined.reserved) AS inventory_position
      FROM combined
      LEFT JOIN qc_buckets qc
        ON qc.item_id = combined.item_id
       AND qc.location_id = combined.location_id
       AND qc.uom = combined.uom
     WHERE combined.on_hand <> 0 OR combined.reserved <> 0 OR COALESCE(qc.held_qty, 0) <> 0 OR COALESCE(qc.rejected_qty, 0) <> 0
     ORDER BY item_id, location_id, uom
     LIMIT $${paramsList.push(limit)} OFFSET $${paramsList.push(offset)};`,
    paramsList
  );

  return rows.map((row: any) => ({
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
    inventoryPosition: normalizeQuantity(row.inventory_position)
  }));
}
