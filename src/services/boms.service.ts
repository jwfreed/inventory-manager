import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool, query, withTransaction } from '../db';
import { bomActivationSchema, bomCreateSchema } from '../schemas/boms.schema';
import { roundQuantity, toNumber } from '../lib/numbers';
import { normalizeQuantityByUom } from '../lib/uom';

type BomCreateInput = z.infer<typeof bomCreateSchema>;
type BomActivationInput = z.infer<typeof bomActivationSchema>;

type BomRow = {
  id: string;
  bom_code: string;
  output_item_id: string;
  default_uom: string;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type BomVersionRow = {
  id: string;
  bom_id: string;
  version_number: number;
  status: string;
  effective_from: string | null;
  effective_to: string | null;
  yield_quantity: string | number;
  yield_uom: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type BomVersionLineRow = {
  id: string;
  bom_version_id: string;
  line_number: number;
  component_item_id: string;
  component_quantity: string | number;
  component_uom: string;
  scrap_factor: string | number | null;
  uses_pack_size: boolean;
  variable_uom: string | null;
  notes: string | null;
  created_at: string;
};

export type BomVersionLine = {
  id: string;
  bomVersionId: string;
  lineNumber: number;
  componentItemId: string;
  quantityPer: number;
  uom: string;
  scrapFactor: number | null;
  usesPackSize: boolean;
  variableUom: string | null;
  notes: string | null;
  createdAt: string;
};

export type BomVersion = {
  id: string;
  bomId: string;
  versionNumber: number;
  status: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  yieldQuantity: number;
  yieldUom: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  components: BomVersionLine[];
};

export type Bom = {
  id: string;
  bomCode: string;
  outputItemId: string;
  defaultUom: string;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  versions: BomVersion[];
};

type BomListVersion = Omit<BomVersion, 'components'>;

function mapBomVersionLine(row: BomVersionLineRow): BomVersionLine {
  return {
    id: row.id,
    bomVersionId: row.bom_version_id,
    lineNumber: row.line_number,
    componentItemId: row.component_item_id,
    quantityPer: roundQuantity(toNumber(row.component_quantity)),
    uom: row.component_uom,
    scrapFactor: row.scrap_factor !== null ? roundQuantity(toNumber(row.scrap_factor)) : null,
    usesPackSize: !!row.uses_pack_size,
    variableUom: row.variable_uom,
    notes: row.notes,
    createdAt: row.created_at
  };
}

function mapBomVersion(row: BomVersionRow, lines: BomVersionLineRow[]): BomVersion {
  return {
    id: row.id,
    bomId: row.bom_id,
    versionNumber: row.version_number,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    yieldQuantity: roundQuantity(toNumber(row.yield_quantity)),
    yieldUom: row.yield_uom,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    components: lines.map((line) => mapBomVersionLine(line))
  };
}

function mapBom(row: BomRow, versionRows: BomVersionRow[], lineMap: Map<string, BomVersionLineRow[]>): Bom {
  return {
    id: row.id,
    bomCode: row.bom_code,
    outputItemId: row.output_item_id,
    defaultUom: row.default_uom,
    active: row.active,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    versions: versionRows.map((versionRow) => mapBomVersion(versionRow, lineMap.get(versionRow.id) ?? []))
  };
}

export async function fetchBomById(id: string, client?: PoolClient): Promise<Bom | null> {
  const executor = client ?? pool;
  const bomResult = await executor.query<BomRow>('SELECT * FROM boms WHERE id = $1', [id]);
  if (bomResult.rowCount === 0) {
    return null;
  }
  const versionResult = await executor.query<BomVersionRow>(
    'SELECT * FROM bom_versions WHERE bom_id = $1 ORDER BY version_number ASC',
    [id]
  );
  const versionIds = versionResult.rows.map((version) => version.id);
  let lineRows: BomVersionLineRow[] = [];
  if (versionIds.length > 0) {
    const { rows } = await executor.query<BomVersionLineRow>(
      'SELECT * FROM bom_version_lines WHERE bom_version_id = ANY($1::uuid[]) ORDER BY line_number ASC',
      [versionIds]
    );
    lineRows = rows;
  }
  const lineMap = new Map<string, BomVersionLineRow[]>();
  for (const line of lineRows) {
    const arr = lineMap.get(line.bom_version_id) ?? [];
    arr.push(line);
    lineMap.set(line.bom_version_id, arr);
  }
  return mapBom(bomResult.rows[0], versionResult.rows, lineMap);
}

function normalizeComponents(components: BomCreateInput['version']['components']) {
  const lineNumbers = new Set<number>();
  return components.map((component) => {
    if (lineNumbers.has(component.lineNumber)) {
      throw new Error('BOM_COMPONENT_DUPLICATE_LINE');
    }
    lineNumbers.add(component.lineNumber);
    return component;
  });
}

export async function createBom(data: BomCreateInput): Promise<Bom> {
  normalizeComponents(data.version.components);
  const now = new Date();
  const bomId = uuidv4();
  const versionId = uuidv4();
  const versionNumber = data.version.versionNumber ?? 1;

  const bom = await withTransaction(async (client) => {
    const normalizedYield = normalizeQuantityByUom(data.version.yieldQuantity, data.version.yieldUom);

    await client.query(
      `INSERT INTO boms (id, bom_code, output_item_id, default_uom, active, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, $5, $6, $6)`,
      [bomId, data.bomCode, data.outputItemId, data.defaultUom, data.notes ?? null, now]
    );

    await client.query(
      `INSERT INTO bom_versions (
          id, bom_id, version_number, status, effective_from, effective_to,
          yield_quantity, yield_uom, notes, created_at, updated_at
       ) VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $9)`,
      [
        versionId,
        bomId,
        versionNumber,
        data.version.effectiveFrom ?? null,
        data.version.effectiveTo ?? null,
        normalizedYield.quantity,
        normalizedYield.uom,
        data.version.notes ?? null,
        now
      ]
    );

    for (const component of data.version.components) {
      const normalized = normalizeQuantityByUom(component.quantityPer, component.uom);
      await client.query(
        `INSERT INTO bom_version_lines (
            id, bom_version_id, line_number, component_item_id, component_quantity,
            component_uom, scrap_factor, uses_pack_size, variable_uom, notes, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          uuidv4(),
          versionId,
          component.lineNumber,
          component.componentItemId,
          normalized.quantity,
          normalized.uom,
          component.scrapFactor !== undefined ? roundQuantity(component.scrapFactor) : null,
          component.usesPackSize ?? false,
          component.variableUom ?? null,
          component.notes ?? null,
          now
        ]
      );
    }

    const created = await fetchBomById(bomId, client);
    if (!created) {
      throw new Error('BOM_NOT_FOUND_AFTER_CREATE');
    }
    return created;
  });

  return bom;
}

export async function listBomsByItem(itemId: string) {
  const { rows } = await query(
    `SELECT
        b.id AS bom_id,
        b.bom_code,
        b.output_item_id,
        b.default_uom,
        b.active,
        b.notes AS bom_notes,
        b.created_at AS bom_created_at,
        b.updated_at AS bom_updated_at,
        v.id AS version_id,
        v.version_number,
        v.status,
        v.effective_from,
        v.effective_to,
        v.yield_quantity,
        v.yield_uom,
        v.notes AS version_notes,
        v.created_at AS version_created_at,
        v.updated_at AS version_updated_at
     FROM boms b
     LEFT JOIN bom_versions v ON v.bom_id = b.id
     WHERE b.output_item_id = $1
     ORDER BY b.created_at DESC, v.version_number DESC`,
    [itemId]
  );

  const bomMap = new Map<
    string,
    {
      id: string;
      bomCode: string;
      outputItemId: string;
      defaultUom: string;
      active: boolean;
      notes: string | null;
      createdAt: string;
      updatedAt: string;
      versions: BomListVersion[];
    }
  >();

  for (const row of rows) {
    let entry = bomMap.get(row.bom_id);
    if (!entry) {
      entry = {
        id: row.bom_id,
        bomCode: row.bom_code,
        outputItemId: row.output_item_id,
        defaultUom: row.default_uom,
        active: row.active,
        notes: row.bom_notes,
        createdAt: row.bom_created_at,
        updatedAt: row.bom_updated_at,
        versions: []
      };
      bomMap.set(row.bom_id, entry);
    }
    if (row.version_id) {
      entry.versions.push({
        id: row.version_id,
        bomId: row.bom_id,
        versionNumber: row.version_number,
        status: row.status,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
        yieldQuantity: roundQuantity(toNumber(row.yield_quantity ?? 0)),
        yieldUom: row.yield_uom,
        notes: row.version_notes,
        createdAt: row.version_created_at,
        updatedAt: row.version_updated_at,
        components: []
      });
    }
  }

  return { itemId, boms: Array.from(bomMap.values()) };
}

function rangesOverlap(
  existingFrom: string | null,
  existingTo: string | null,
  candidateFrom: Date,
  candidateTo: Date | null
): boolean {
  const existingFromTime = existingFrom ? new Date(existingFrom).getTime() : Number.NEGATIVE_INFINITY;
  const existingToTime = existingTo ? new Date(existingTo).getTime() : Number.POSITIVE_INFINITY;
  const candidateFromTime = candidateFrom.getTime();
  const candidateToTime = candidateTo ? candidateTo.getTime() : Number.POSITIVE_INFINITY;
  return candidateFromTime <= existingToTime && existingFromTime <= candidateToTime;
}

export async function activateBomVersion(
  versionId: string,
  _data: BomActivationInput,
  effectiveFrom: Date,
  effectiveTo: Date | null
): Promise<Bom> {
  const effectiveFromIso = effectiveFrom.toISOString();
  const effectiveToIso = effectiveTo ? effectiveTo.toISOString() : null;
  const now = new Date();

  const bom = await withTransaction(async (client) => {
    const versionResult = await client.query<
      BomVersionRow & { output_item_id: string }
    >(
      `SELECT v.*, b.output_item_id
         FROM bom_versions v
         JOIN boms b ON b.id = v.bom_id
        WHERE v.id = $1
        FOR UPDATE`,
      [versionId]
    );
    if (versionResult.rowCount === 0) {
      throw new Error('BOM_VERSION_NOT_FOUND');
    }
    const versionRow = versionResult.rows[0];
    if (versionRow.status === 'active') {
      throw new Error('BOM_VERSION_ALREADY_ACTIVE');
    }

    const { rows: activeRows } = await client.query(
      `SELECT v.id, v.effective_from, v.effective_to
         FROM bom_versions v
         JOIN boms b ON b.id = v.bom_id
        WHERE b.output_item_id = $1
          AND v.status = 'active'
          AND v.id <> $2`,
      [versionRow.output_item_id, versionId]
    );
    for (const row of activeRows) {
      if (rangesOverlap(row.effective_from, row.effective_to, effectiveFrom, effectiveTo)) {
        throw new Error('BOM_EFFECTIVE_RANGE_OVERLAP');
      }
    }

    await client.query(
      `UPDATE bom_versions
          SET status = 'active',
              effective_from = $2,
              effective_to = $3,
              updated_at = $4
        WHERE id = $1`,
      [versionId, effectiveFromIso, effectiveToIso, now]
    );

    const updated = await fetchBomById(versionRow.bom_id, client);
    if (!updated) {
      throw new Error('BOM_NOT_FOUND_AFTER_UPDATE');
    }
    return updated;
  });

  return bom;
}

export async function resolveEffectiveBom(itemId: string, asOfIso: string) {
  const { rows } = await query<{ bom_id: string; version_id: string }>(
    `SELECT b.id AS bom_id, v.id AS version_id
       FROM boms b
       JOIN bom_versions v ON v.bom_id = b.id
      WHERE b.output_item_id = $1
        AND v.status = 'active'
        AND v.effective_from <= $2
        AND (v.effective_to IS NULL OR v.effective_to >= $2)
      ORDER BY v.effective_from DESC
      LIMIT 1`,
    [itemId, asOfIso]
  );
  if (rows.length === 0) {
    return null;
  }

  const { bom_id: bomId, version_id: versionId } = rows[0];
  const bom = await fetchBomById(bomId);
  if (!bom) {
    throw new Error('BOM_NOT_FOUND');
  }
  const version = bom.versions.find((v) => v.id === versionId);
  if (!version) {
    throw new Error('BOM_VERSION_NOT_FOUND');
  }

  return {
    itemId,
    asOf: asOfIso,
    bom: {
      id: bom.id,
      bomCode: bom.bomCode,
      outputItemId: bom.outputItemId,
      defaultUom: bom.defaultUom,
      active: bom.active,
      notes: bom.notes,
      createdAt: bom.createdAt,
      updatedAt: bom.updatedAt
    },
    version
  };
}
