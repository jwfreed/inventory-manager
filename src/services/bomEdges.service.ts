import { toNumber } from '../lib/numbers';

type Queryable = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;
};

type EffectiveBomLineRow = {
  parent_item_id: string;
  bom_id: string;
  bom_version_id: string;
  yield_quantity: string | number;
  yield_uom: string;
  yield_factor: string | number | null;
  line_id: string;
  line_number: number;
  component_item_id: string;
  component_quantity: string | number;
  component_uom: string;
  component_quantity_entered: string | number | null;
  component_uom_entered: string | null;
  component_quantity_canonical: string | number | null;
  component_uom_canonical: string | null;
  component_uom_dimension: string | null;
  scrap_factor: string | number | null;
  uses_pack_size: boolean;
  variable_uom: string | null;
  notes: string | null;
  component_is_phantom: boolean;
};

type EffectiveBomEdgeRow = {
  parent_item_id: string;
  component_item_id: string;
  line_id: string;
};

export type EffectiveBomLineForParent = {
  id: string;
  lineNumber: number;
  componentItemId: string;
  quantityPer: number;
  uom: string;
  quantityPerCanonical: number | null;
  uomCanonical: string | null;
  uomDimension: string | null;
  scrapFactor: number | null;
  usesPackSize: boolean;
  variableUom: string | null;
  notes: string | null;
  componentIsPhantom: boolean;
};

export type EffectiveBomForParent = {
  parentItemId: string;
  bomId: string;
  bomVersionId: string;
  yieldQuantity: number;
  yieldUom: string;
  yieldFactor: number;
  components: EffectiveBomLineForParent[];
};

export type EffectiveBomEdge = {
  parentItemId: string;
  componentItemId: string;
  lineId: string;
};

function asOfIso(asOfDate?: Date | string) {
  if (!asOfDate) return new Date().toISOString();
  if (typeof asOfDate === 'string') return asOfDate;
  return asOfDate.toISOString();
}

function effectiveVersionCte(paramTenant = '$1', paramAsOf = '$2') {
  return `
    WITH ranked_effective_versions AS (
      SELECT b.tenant_id,
             b.output_item_id,
             b.id AS bom_id,
             v.id AS bom_version_id,
             v.yield_quantity,
             v.yield_uom,
             v.yield_factor,
             ROW_NUMBER() OVER (
               PARTITION BY b.output_item_id
               ORDER BY v.effective_from DESC, v.version_number DESC, v.created_at DESC, v.id DESC
             ) AS version_rank
        FROM boms b
        JOIN bom_versions v
          ON v.bom_id = b.id
         AND v.tenant_id = b.tenant_id
       WHERE b.tenant_id = ${paramTenant}
         AND v.status = 'active'
         AND v.effective_from <= ${paramAsOf}::timestamptz
         AND (v.effective_to IS NULL OR v.effective_to >= ${paramAsOf}::timestamptz)
    )
  `;
}

export async function getEffectiveBomLinesForParent(
  client: Queryable,
  tenantId: string,
  parentItemId: string,
  asOfDate?: Date | string
): Promise<EffectiveBomForParent | null> {
  const sql = `
    ${effectiveVersionCte('$1', '$2')}
    SELECT ev.output_item_id AS parent_item_id,
           ev.bom_id,
           ev.bom_version_id,
           ev.yield_quantity,
           ev.yield_uom,
           ev.yield_factor,
           l.id AS line_id,
           l.line_number,
           l.component_item_id,
           l.component_quantity,
           l.component_uom,
           l.component_quantity_entered,
           l.component_uom_entered,
           l.component_quantity_canonical,
           l.component_uom_canonical,
           l.component_uom_dimension,
           l.scrap_factor,
           l.uses_pack_size,
           l.variable_uom,
           l.notes,
           component.is_phantom AS component_is_phantom
      FROM ranked_effective_versions ev
      JOIN bom_version_lines l
        ON l.tenant_id = ev.tenant_id
       AND l.bom_version_id = ev.bom_version_id
      JOIN items component
        ON component.id = l.component_item_id
       AND component.tenant_id = ev.tenant_id
     WHERE ev.version_rank = 1
       AND ev.output_item_id = $3
     ORDER BY l.component_item_id ASC, l.id ASC
  `;
  const res = await client.query(sql, [tenantId, asOfIso(asOfDate), parentItemId]) as {
    rows: EffectiveBomLineRow[];
    rowCount: number | null;
  };
  if (!res.rowCount || res.rowCount <= 0) {
    return null;
  }
  const first = res.rows[0];
  return {
    parentItemId: first.parent_item_id,
    bomId: first.bom_id,
    bomVersionId: first.bom_version_id,
    yieldQuantity: toNumber(first.yield_quantity),
    yieldUom: first.yield_uom,
    yieldFactor: first.yield_factor === null ? 1 : toNumber(first.yield_factor),
    components: res.rows.map((row: EffectiveBomLineRow) => ({
      id: row.line_id,
      lineNumber: row.line_number,
      componentItemId: row.component_item_id,
      quantityPer: toNumber(row.component_quantity_entered ?? row.component_quantity),
      uom: row.component_uom_entered ?? row.component_uom,
      quantityPerCanonical:
        row.component_quantity_canonical === null ? null : toNumber(row.component_quantity_canonical),
      uomCanonical: row.component_uom_canonical ?? null,
      uomDimension: row.component_uom_dimension ?? null,
      scrapFactor: row.scrap_factor === null ? null : toNumber(row.scrap_factor),
      usesPackSize: !!row.uses_pack_size,
      variableUom: row.variable_uom ?? null,
      notes: row.notes ?? null,
      componentIsPhantom: !!row.component_is_phantom
    }))
  };
}

export async function getAllEffectiveBomEdges(
  client: Queryable,
  tenantId: string,
  asOfDate?: Date | string
): Promise<EffectiveBomEdge[]> {
  const sql = `
    ${effectiveVersionCte('$1', '$2')}
    SELECT ev.output_item_id AS parent_item_id,
           l.component_item_id,
           l.id AS line_id
      FROM ranked_effective_versions ev
      JOIN bom_version_lines l
        ON l.tenant_id = ev.tenant_id
       AND l.bom_version_id = ev.bom_version_id
      JOIN items component
        ON component.id = l.component_item_id
       AND component.tenant_id = ev.tenant_id
     WHERE ev.version_rank = 1
       AND component.is_phantom = true
     ORDER BY ev.output_item_id ASC, l.component_item_id ASC, l.id ASC
  `;
  const res = await client.query(sql, [tenantId, asOfIso(asOfDate)]) as {
    rows: EffectiveBomEdgeRow[];
    rowCount: number | null;
  };
  return res.rows.map((row: EffectiveBomEdgeRow) => ({
    parentItemId: row.parent_item_id,
    componentItemId: row.component_item_id,
    lineId: row.line_id
  }));
}
