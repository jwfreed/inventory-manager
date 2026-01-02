import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';

export type SupplierScorecard = {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  
  // PO Metrics
  totalPurchaseOrders: number;
  totalPoLines: number;
  
  // Delivery Metrics
  totalReceipts: number;
  onTimeReceipts: number;
  lateReceipts: number;
  onTimeDeliveryRate: number; // Percentage
  averageDaysLate: number | null;
  
  // Quality Metrics
  totalQcEvents: number;
  acceptedQuantity: number;
  rejectedQuantity: number;
  heldQuantity: number;
  totalNcrs: number;
  openNcrs: number;
  closedNcrs: number;
  qualityRate: number; // Percentage (accepted / total)
  
  // Disposition Metrics
  returnToVendorCount: number;
  scrapCount: number;
  reworkCount: number;
  useAsIsCount: number;
};

export type SupplierScorecardParams = {
  vendorId?: string;
  startDate?: string; // ISO date string
  endDate?: string; // ISO date string
  limit?: number;
  offset?: number;
};

function normalizeQuantity(value: unknown): number {
  return roundQuantity(toNumber(value));
}

/**
 * Get supplier scorecards with on-time delivery and quality metrics
 */
export async function getSupplierScorecards(
  tenantId: string,
  params: SupplierScorecardParams = {}
): Promise<SupplierScorecard[]> {
  const paramsList: any[] = [tenantId];
  const whereClauses: string[] = [];

  if (params.vendorId) {
    whereClauses.push(`po.vendor_id = $${paramsList.push(params.vendorId)}`);
  }
  if (params.startDate) {
    whereClauses.push(`po.created_at >= $${paramsList.push(params.startDate)}::date`);
  }
  if (params.endDate) {
    whereClauses.push(`po.created_at <= $${paramsList.push(params.endDate)}::date`);
  }

  const whereClause = whereClauses.length > 0 
    ? `AND ${whereClauses.join(' AND ')}` 
    : '';

  const limit = params.limit ?? 100;
  const offset = params.offset ?? 0;

  const { rows } = await query(
    `WITH vendor_pos AS (
       -- Get all POs for each vendor
       SELECT 
         v.id AS vendor_id,
         v.code AS vendor_code,
         v.name AS vendor_name,
         COUNT(DISTINCT po.id) AS total_pos,
         COUNT(pol.id) AS total_po_lines
       FROM vendors v
       LEFT JOIN purchase_orders po ON po.vendor_id = v.id AND po.tenant_id = $1 ${whereClause}
       LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id AND pol.tenant_id = $1
       WHERE v.tenant_id = $1
       GROUP BY v.id, v.code, v.name
     ),
     delivery_metrics AS (
       -- Calculate on-time delivery metrics
       SELECT 
         po.vendor_id,
         COUNT(DISTINCT por.id) AS total_receipts,
         COUNT(DISTINCT CASE 
           WHEN po.expected_date IS NOT NULL 
             AND DATE(por.received_at) <= po.expected_date 
           THEN por.id 
         END) AS on_time_receipts,
         COUNT(DISTINCT CASE 
           WHEN po.expected_date IS NOT NULL 
             AND DATE(por.received_at) > po.expected_date 
           THEN por.id 
         END) AS late_receipts,
         AVG(
           CASE 
             WHEN po.expected_date IS NOT NULL 
               AND DATE(por.received_at) > po.expected_date 
             THEN DATE(por.received_at) - po.expected_date 
           END
         ) AS avg_days_late
       FROM purchase_orders po
       JOIN purchase_order_receipts por ON por.purchase_order_id = po.id AND por.tenant_id = $1
       WHERE po.tenant_id = $1 ${whereClause}
       GROUP BY po.vendor_id
     ),
     quality_metrics AS (
       -- Calculate quality metrics from QC events
       SELECT 
         po.vendor_id,
         COUNT(qe.id) AS total_qc_events,
         SUM(CASE WHEN qe.event_type = 'accept' THEN qe.quantity ELSE 0 END) AS accepted_qty,
         SUM(CASE WHEN qe.event_type = 'reject' THEN qe.quantity ELSE 0 END) AS rejected_qty,
         SUM(CASE WHEN qe.event_type = 'hold' THEN qe.quantity ELSE 0 END) AS held_qty
       FROM purchase_orders po
       JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id AND pol.tenant_id = $1
       JOIN purchase_order_receipt_lines prl ON prl.purchase_order_line_id = pol.id AND prl.tenant_id = $1
       JOIN qc_events qe ON qe.purchase_order_receipt_line_id = prl.id AND qe.tenant_id = $1
       WHERE po.tenant_id = $1 ${whereClause}
       GROUP BY po.vendor_id
     ),
     ncr_metrics AS (
       -- Calculate NCR metrics
       SELECT 
         po.vendor_id,
         COUNT(n.id) AS total_ncrs,
         COUNT(CASE WHEN n.status = 'open' THEN 1 END) AS open_ncrs,
         COUNT(CASE WHEN n.status = 'closed' THEN 1 END) AS closed_ncrs,
         COUNT(CASE WHEN n.disposition_type = 'return_to_vendor' THEN 1 END) AS return_to_vendor,
         COUNT(CASE WHEN n.disposition_type = 'scrap' THEN 1 END) AS scrap,
         COUNT(CASE WHEN n.disposition_type = 'rework' THEN 1 END) AS rework,
         COUNT(CASE WHEN n.disposition_type = 'use_as_is' THEN 1 END) AS use_as_is
       FROM purchase_orders po
       JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id AND pol.tenant_id = $1
       JOIN purchase_order_receipt_lines prl ON prl.purchase_order_line_id = pol.id AND prl.tenant_id = $1
       JOIN qc_events qe ON qe.purchase_order_receipt_line_id = prl.id AND qe.tenant_id = $1
       JOIN ncrs n ON n.qc_event_id = qe.id AND n.tenant_id = $1
       WHERE po.tenant_id = $1 ${whereClause}
       GROUP BY po.vendor_id
     )
    SELECT 
      vp.vendor_id,
      vp.vendor_code,
      vp.vendor_name,
      COALESCE(vp.total_pos, 0) AS total_pos,
      COALESCE(vp.total_po_lines, 0) AS total_po_lines,
      COALESCE(dm.total_receipts, 0) AS total_receipts,
      COALESCE(dm.on_time_receipts, 0) AS on_time_receipts,
      COALESCE(dm.late_receipts, 0) AS late_receipts,
      CASE 
        WHEN dm.total_receipts > 0 
        THEN ROUND((dm.on_time_receipts::numeric / dm.total_receipts::numeric) * 100, 2)
        ELSE 0 
      END AS on_time_delivery_rate,
      dm.avg_days_late,
      COALESCE(qm.total_qc_events, 0) AS total_qc_events,
      COALESCE(qm.accepted_qty, 0) AS accepted_qty,
      COALESCE(qm.rejected_qty, 0) AS rejected_qty,
      COALESCE(qm.held_qty, 0) AS held_qty,
      COALESCE(nm.total_ncrs, 0) AS total_ncrs,
      COALESCE(nm.open_ncrs, 0) AS open_ncrs,
      COALESCE(nm.closed_ncrs, 0) AS closed_ncrs,
      CASE 
        WHEN (COALESCE(qm.accepted_qty, 0) + COALESCE(qm.rejected_qty, 0)) > 0 
        THEN ROUND((qm.accepted_qty::numeric / (qm.accepted_qty + qm.rejected_qty)::numeric) * 100, 2)
        ELSE 100 
      END AS quality_rate,
      COALESCE(nm.return_to_vendor, 0) AS return_to_vendor,
      COALESCE(nm.scrap, 0) AS scrap,
      COALESCE(nm.rework, 0) AS rework,
      COALESCE(nm.use_as_is, 0) AS use_as_is
    FROM vendor_pos vp
    LEFT JOIN delivery_metrics dm ON dm.vendor_id = vp.vendor_id
    LEFT JOIN quality_metrics qm ON qm.vendor_id = vp.vendor_id
    LEFT JOIN ncr_metrics nm ON nm.vendor_id = vp.vendor_id
    WHERE vp.total_pos > 0 OR dm.total_receipts > 0 OR qm.total_qc_events > 0
    ORDER BY vp.vendor_name
    LIMIT $${paramsList.push(limit)} OFFSET $${paramsList.push(offset)}`,
    paramsList
  );

  return rows.map((row: any) => ({
    vendorId: row.vendor_id,
    vendorCode: row.vendor_code,
    vendorName: row.vendor_name,
    totalPurchaseOrders: Number(row.total_pos),
    totalPoLines: Number(row.total_po_lines),
    totalReceipts: Number(row.total_receipts),
    onTimeReceipts: Number(row.on_time_receipts),
    lateReceipts: Number(row.late_receipts),
    onTimeDeliveryRate: Number(row.on_time_delivery_rate),
    averageDaysLate: row.avg_days_late ? Number(row.avg_days_late) : null,
    totalQcEvents: Number(row.total_qc_events),
    acceptedQuantity: normalizeQuantity(row.accepted_qty),
    rejectedQuantity: normalizeQuantity(row.rejected_qty),
    heldQuantity: normalizeQuantity(row.held_qty),
    totalNcrs: Number(row.total_ncrs),
    openNcrs: Number(row.open_ncrs),
    closedNcrs: Number(row.closed_ncrs),
    qualityRate: Number(row.quality_rate),
    returnToVendorCount: Number(row.return_to_vendor),
    scrapCount: Number(row.scrap),
    reworkCount: Number(row.rework),
    useAsIsCount: Number(row.use_as_is)
  }));
}

/**
 * Get detailed scorecard for a specific supplier
 */
export async function getSupplierScorecardDetail(
  tenantId: string,
  vendorId: string,
  startDate?: string,
  endDate?: string
): Promise<SupplierScorecard | null> {
  const results = await getSupplierScorecards(tenantId, {
    vendorId,
    startDate,
    endDate,
    limit: 1
  });

  return results.length > 0 ? results[0] : null;
}

/**
 * Get top performing suppliers by on-time delivery
 */
export async function getTopSuppliersByDelivery(
  tenantId: string,
  limit: number = 10
): Promise<SupplierScorecard[]> {
  const scorecards = await getSupplierScorecards(tenantId, { limit: 1000 });
  
  return scorecards
    .filter(s => s.totalReceipts >= 3) // Minimum 3 receipts for meaningful data
    .sort((a, b) => b.onTimeDeliveryRate - a.onTimeDeliveryRate)
    .slice(0, limit);
}

/**
 * Get top performing suppliers by quality
 */
export async function getTopSuppliersByQuality(
  tenantId: string,
  limit: number = 10
): Promise<SupplierScorecard[]> {
  const scorecards = await getSupplierScorecards(tenantId, { limit: 1000 });
  
  return scorecards
    .filter(s => s.totalQcEvents >= 5) // Minimum 5 QC events for meaningful data
    .sort((a, b) => b.qualityRate - a.qualityRate)
    .slice(0, limit);
}

/**
 * Get suppliers with quality issues (high NCR or rejection rates)
 */
export async function getSuppliersWithQualityIssues(
  tenantId: string,
  minRejectionRate: number = 5 // Default 5% rejection rate threshold
): Promise<SupplierScorecard[]> {
  const scorecards = await getSupplierScorecards(tenantId, { limit: 1000 });
  
  return scorecards
    .filter(s => {
      const totalInspected = s.acceptedQuantity + s.rejectedQuantity;
      if (totalInspected === 0) return false;
      
      const rejectionRate = (s.rejectedQuantity / totalInspected) * 100;
      return rejectionRate >= minRejectionRate || s.openNcrs > 0;
    })
    .sort((a, b) => {
      const aRejectionRate = (a.rejectedQuantity / (a.acceptedQuantity + a.rejectedQuantity)) * 100;
      const bRejectionRate = (b.rejectedQuantity / (b.acceptedQuantity + b.rejectedQuantity)) * 100;
      return bRejectionRate - aRejectionRate;
    });
}
