import { query } from '../db';

// Lead Time Reliability Types
export type LeadTimeReliabilityRow = {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  totalReceipts: number;
  onTimeReceipts: number;
  lateReceipts: number;
  avgLeadTimeDays: number;
  avgPromisedLeadTimeDays: number;
  reliabilityPercent: number;
};

export async function getLeadTimeReliability(params: {
  tenantId: string;
  startDate: string;
  endDate: string;
  vendorId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ data: LeadTimeReliabilityRow[] }> {
  const {
    tenantId,
    startDate,
    endDate,
    vendorId,
    limit = 100,
    offset = 0,
  } = params;

  let whereConditions = ['por.tenant_id = $1', 'por.status = $2'];
  const queryParams: any[] = [tenantId, 'posted'];
  let paramIndex = 3;

  queryParams.push(startDate);
  whereConditions.push(`por.received_at >= $${paramIndex}::timestamptz`);
  paramIndex++;

  queryParams.push(endDate);
  whereConditions.push(`por.received_at <= $${paramIndex}::timestamptz`);
  paramIndex++;

  if (vendorId) {
    whereConditions.push(`po.vendor_id = $${paramIndex}`);
    queryParams.push(vendorId);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');

  const sql = `
    SELECT 
      v.id as "vendorId",
      v.code as "vendorCode",
      v.name as "vendorName",
      COUNT(por.id)::integer as "totalReceipts",
      SUM(
        CASE 
          WHEN po.expected_date IS NOT NULL 
            AND por.received_at::date <= po.expected_date THEN 1
          ELSE 0
        END
      )::integer as "onTimeReceipts",
      SUM(
        CASE 
          WHEN po.expected_date IS NOT NULL 
            AND por.received_at::date > po.expected_date THEN 1
          ELSE 0
        END
      )::integer as "lateReceipts",
      ROUND(AVG(por.received_at::date - po.order_date)::numeric, 2) as "avgLeadTimeDays",
      ROUND(AVG(
        CASE 
          WHEN po.expected_date IS NOT NULL THEN
            (po.expected_date - po.order_date)
          ELSE NULL
        END
      )::numeric, 2) as "avgPromisedLeadTimeDays",
      CASE 
        WHEN COUNT(por.id) > 0 THEN
          ROUND((SUM(
            CASE 
              WHEN po.expected_date IS NOT NULL 
                AND por.received_at::date <= po.expected_date THEN 1
              ELSE 0
            END
          )::numeric / COUNT(por.id) * 100), 2)
        ELSE 0
      END as "reliabilityPercent"
    FROM purchase_order_receipts por
    JOIN purchase_orders po ON por.purchase_order_id = po.id
    JOIN vendors v ON po.vendor_id = v.id
    WHERE ${whereClause}
    GROUP BY v.id, v.code, v.name
    HAVING COUNT(por.id) > 0
    ORDER BY "reliabilityPercent" DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  queryParams.push(limit, offset);

  const result = await query<LeadTimeReliabilityRow>(sql, queryParams);
  return { data: result.rows };
}

// Price Variance Trends Types
export type PriceVarianceTrendRow = {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  month: string;
  avgUnitCost: number;
  avgReceivedCost: number;
  variancePercent: number;
  totalReceiptLines: number;
};

export async function getPriceVarianceTrends(params: {
  tenantId: string;
  startDate: string;
  endDate: string;
  vendorId?: string;
  limit?: number;
}): Promise<{ data: PriceVarianceTrendRow[] }> {
  const {
    tenantId,
    startDate,
    endDate,
    vendorId,
    limit = 100,
  } = params;

  let whereConditions = ['por.tenant_id = $1', 'por.status = $2'];
  const queryParams: any[] = [tenantId, 'posted'];
  let paramIndex = 3;

  queryParams.push(startDate);
  whereConditions.push(`por.received_at >= $${paramIndex}::timestamptz`);
  paramIndex++;

  queryParams.push(endDate);
  whereConditions.push(`por.received_at <= $${paramIndex}::timestamptz`);
  paramIndex++;

  if (vendorId) {
    whereConditions.push(`po.vendor_id = $${paramIndex}`);
    queryParams.push(vendorId);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');

  const sql = `
    SELECT 
      v.id as "vendorId",
      v.code as "vendorCode",
      v.name as "vendorName",
      TO_CHAR(DATE_TRUNC('month', por.received_at), 'YYYY-MM') as month,
      ROUND(AVG(pol.unit_cost)::numeric, 2) as "avgUnitCost",
      ROUND(AVG(porl.unit_cost)::numeric, 2) as "avgReceivedCost",
      CASE 
        WHEN AVG(pol.unit_cost) > 0 THEN
          ROUND(((AVG(porl.unit_cost) - AVG(pol.unit_cost)) / AVG(pol.unit_cost) * 100)::numeric, 2)
        ELSE 0
      END as "variancePercent",
      COUNT(porl.id)::integer as "totalReceiptLines"
    FROM purchase_order_receipts por
    JOIN purchase_orders po ON por.purchase_order_id = po.id
    JOIN vendors v ON po.vendor_id = v.id
    JOIN purchase_order_receipt_lines porl ON porl.purchase_order_receipt_id = por.id
    JOIN purchase_order_lines pol ON porl.purchase_order_line_id = pol.id
    WHERE ${whereClause}
    GROUP BY v.id, v.code, v.name, DATE_TRUNC('month', por.received_at)
    ORDER BY month DESC, v.code
    LIMIT $${paramIndex}
  `;

  queryParams.push(limit);

  const result = await query<PriceVarianceTrendRow>(sql, queryParams);
  return { data: result.rows };
}

// Vendor Fill Rate Types
export type VendorFillRateRow = {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  totalOrdered: number;
  totalReceived: number;
  fillRatePercent: number;
  totalPOs: number;
  fullyReceivedPOs: number;
};

export async function getVendorFillRate(params: {
  tenantId: string;
  startDate: string;
  endDate: string;
  vendorId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ data: VendorFillRateRow[] }> {
  const {
    tenantId,
    startDate,
    endDate,
    vendorId,
    limit = 100,
    offset = 0,
  } = params;

  let whereConditions = ['po.tenant_id = $1'];
  const queryParams: any[] = [tenantId];
  let paramIndex = 2;

  queryParams.push(startDate);
  whereConditions.push(`po.order_date >= $${paramIndex}::date`);
  paramIndex++;

  queryParams.push(endDate);
  whereConditions.push(`po.order_date <= $${paramIndex}::date`);
  paramIndex++;

  if (vendorId) {
    whereConditions.push(`po.vendor_id = $${paramIndex}`);
    queryParams.push(vendorId);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');

  const sql = `
    WITH po_aggregates AS (
      SELECT 
        po.id as po_id,
        po.vendor_id,
        SUM(pol.quantity_ordered) as total_ordered,
        COALESCE(SUM(rcpt.quantity_received), 0) as total_received
      FROM purchase_orders po
      JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
      LEFT JOIN (
        SELECT 
          porl.purchase_order_line_id,
          SUM(porl.quantity_received) as quantity_received
        FROM purchase_order_receipt_lines porl
        JOIN purchase_order_receipts por ON porl.purchase_order_receipt_id = por.id
        WHERE por.status = 'posted'
        GROUP BY porl.purchase_order_line_id
      ) rcpt ON pol.id = rcpt.purchase_order_line_id
      WHERE ${whereClause}
      GROUP BY po.id, po.vendor_id
    )
    SELECT 
      v.id as "vendorId",
      v.code as "vendorCode",
      v.name as "vendorName",
      SUM(pa.total_ordered)::numeric as "totalOrdered",
      SUM(pa.total_received)::numeric as "totalReceived",
      CASE 
        WHEN SUM(pa.total_ordered) > 0 THEN
          ROUND((SUM(pa.total_received) / SUM(pa.total_ordered) * 100)::numeric, 2)
        ELSE 0
      END as "fillRatePercent",
      COUNT(pa.po_id)::integer as "totalPOs",
      SUM(
        CASE 
          WHEN pa.total_received >= pa.total_ordered THEN 1
          ELSE 0
        END
      )::integer as "fullyReceivedPOs"
    FROM po_aggregates pa
    JOIN vendors v ON pa.vendor_id = v.id
    GROUP BY v.id, v.code, v.name
    ORDER BY "fillRatePercent" DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  queryParams.push(limit, offset);

  const result = await query<VendorFillRateRow>(sql, queryParams);
  return { data: result.rows };
}

// Quality Rate Types (Placeholder)
export type VendorQualityRateRow = {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  totalReceipts: number;
  passedReceipts: number;
  failedReceipts: number;
  qualityRatePercent: number;
  pendingQC: number;
};

export async function getVendorQualityRate(params: {
  tenantId: string;
  startDate: string;
  endDate: string;
  vendorId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ data: VendorQualityRateRow[] }> {
  const {
    tenantId,
    startDate,
    endDate,
    vendorId,
    limit = 100,
    offset = 0,
  } = params;

  let whereConditions = ['por.tenant_id = $1', 'por.status = $2'];
  const queryParams: any[] = [tenantId, 'posted'];
  let paramIndex = 3;

  queryParams.push(startDate);
  whereConditions.push(`por.received_at >= $${paramIndex}::timestamptz`);
  paramIndex++;

  queryParams.push(endDate);
  whereConditions.push(`por.received_at <= $${paramIndex}::timestamptz`);
  paramIndex++;

  if (vendorId) {
    whereConditions.push(`po.vendor_id = $${paramIndex}`);
    queryParams.push(vendorId);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');

  // Placeholder implementation - returns 100% quality rate for all vendors
  // TODO: Integrate with QC module when available
  const sql = `
    SELECT 
      v.id as "vendorId",
      v.code as "vendorCode",
      v.name as "vendorName",
      COUNT(por.id)::integer as "totalReceipts",
      COUNT(por.id)::integer as "passedReceipts",
      0::integer as "failedReceipts",
      100.00::numeric as "qualityRatePercent",
      0::integer as "pendingQC"
    FROM purchase_order_receipts por
    JOIN purchase_orders po ON por.purchase_order_id = po.id
    JOIN vendors v ON po.vendor_id = v.id
    WHERE ${whereClause}
    GROUP BY v.id, v.code, v.name
    HAVING COUNT(por.id) > 0
    ORDER BY "qualityRatePercent" DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  queryParams.push(limit, offset);

  const result = await query<VendorQualityRateRow>(sql, queryParams);
  return { data: result.rows };
}
