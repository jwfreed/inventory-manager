import express, { Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool, query, withTransaction } from './db';
import type { PoolClient } from 'pg';
import vendorsRouter from './routes/vendors.routes';
import purchaseOrdersRouter from './routes/purchaseOrders.routes';
import receiptsRouter from './routes/receipts.routes';
import qcRouter from './routes/qc.routes';
import putawaysRouter from './routes/putaways.routes';
import closeoutRouter from './routes/closeout.routes';
import adjustmentsRouter from './routes/adjustments.routes';
import countsRouter from './routes/counts.routes';

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json());

// Refactor map:
// - Vendors + Purchase Orders routes are defined under src/routes/*.routes.ts.
// - Receiving + QC routes are defined under src/routes/receipts.routes.ts and qc.routes.ts.
// - Putaway routes are defined under src/routes/putaways.routes.ts.
// - Inbound closeout routes are defined under src/routes/closeout.routes.ts.
// - Inventory adjustment routes are defined under src/routes/adjustments.routes.ts.
// - Inventory count routes are defined under src/routes/counts.routes.ts.
app.use(vendorsRouter);
app.use(purchaseOrdersRouter);
app.use(receiptsRouter);
app.use(qcRouter);
app.use(putawaysRouter);
app.use(closeoutRouter);
app.use(adjustmentsRouter);
app.use(countsRouter);

const bomComponentInputSchema = z.object({
  lineNumber: z.number().int().positive(),
  componentItemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityPer: z.number().positive(),
  scrapFactor: z.number().min(0).optional(),
  notes: z.string().max(2000).optional()
});

const bomVersionInputSchema = z
  .object({
    versionNumber: z.number().int().positive().optional(),
    effectiveFrom: z.string().datetime().optional(),
    effectiveTo: z.string().datetime().optional(),
    yieldQuantity: z.number().positive(),
    yieldUom: z.string().min(1).max(32),
    notes: z.string().max(2000).optional(),
    components: z.array(bomComponentInputSchema).min(1)
  })
  .superRefine((data, ctx) => {
    if (data.effectiveFrom && data.effectiveTo) {
      const from = new Date(data.effectiveFrom);
      const to = new Date(data.effectiveTo);
      if (!(from instanceof Date && !Number.isNaN(from.valueOf()) && to instanceof Date && !Number.isNaN(to.valueOf()))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectiveFrom and effectiveTo must be valid ISO datetimes.',
          path: ['effectiveFrom']
        });
        return;
      }
      if (to <= from) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectiveTo must be after effectiveFrom.',
          path: ['effectiveTo']
        });
      }
    }
  });

const bomCreateSchema = z.object({
  bomCode: z.string().min(1).max(64),
  outputItemId: z.string().uuid(),
  defaultUom: z.string().min(1).max(32),
  notes: z.string().max(2000).optional(),
  version: bomVersionInputSchema
});

const bomActivationSchema = z
  .object({
    effectiveFrom: z.string().datetime(),
    effectiveTo: z.string().datetime().optional()
  })
  .superRefine((data, ctx) => {
    if (data.effectiveTo) {
      const from = new Date(data.effectiveFrom);
      const to = new Date(data.effectiveTo);
      if (!(from instanceof Date && !Number.isNaN(from.valueOf()) && to instanceof Date && !Number.isNaN(to.valueOf()))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectiveFrom and effectiveTo must be valid ISO datetimes.',
          path: ['effectiveFrom']
        });
        return;
      }
      if (to <= from) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectiveTo must be after effectiveFrom.',
          path: ['effectiveTo']
        });
      }
    }
  });

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
}

function roundQuantity(value: number): number {
  return parseFloat(value.toFixed(6));
}

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
  notes: string | null;
  created_at: string;
};

function mapBomVersionLine(row: BomVersionLineRow) {
  return {
    id: row.id,
    bomVersionId: row.bom_version_id,
    lineNumber: row.line_number,
    componentItemId: row.component_item_id,
    quantityPer: roundQuantity(toNumber(row.component_quantity)),
    uom: row.component_uom,
    scrapFactor: row.scrap_factor !== null ? roundQuantity(toNumber(row.scrap_factor)) : null,
    notes: row.notes,
    createdAt: row.created_at
  };
}

function mapBomVersion(row: BomVersionRow, lines: BomVersionLineRow[]) {
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

function mapBom(row: BomRow, versionRows: BomVersionRow[], lineMap: Map<string, BomVersionLineRow[]>) {
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

async function fetchBomById(id: string, client?: PoolClient) {
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

function parseDateInput(value: string): Date | null {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  return date;
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

app.post('/boms', async (req: Request, res: Response) => {
  const parsed = bomCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const data = parsed.data;
  const version = data.version;
  const lineNumbers = new Set<number>();
  for (const component of version.components) {
    if (lineNumbers.has(component.lineNumber)) {
      return res.status(400).json({ error: 'Component line numbers must be unique per BOM version.' });
    }
    lineNumbers.add(component.lineNumber);
  }

  const now = new Date();
  const bomId = uuidv4();
  const versionId = uuidv4();
  const versionNumber = version.versionNumber ?? 1;

  try {
    const createdBom = await withTransaction(async (client: PoolClient) => {
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
          version.effectiveFrom ?? null,
          version.effectiveTo ?? null,
          roundQuantity(version.yieldQuantity),
          version.yieldUom,
          version.notes ?? null,
          now
        ]
      );

      for (const component of version.components) {
        await client.query(
          `INSERT INTO bom_version_lines (
              id, bom_version_id, line_number, component_item_id, component_quantity,
              component_uom, scrap_factor, notes, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            uuidv4(),
            versionId,
            component.lineNumber,
            component.componentItemId,
            roundQuantity(component.quantityPer),
            component.uom,
            component.scrapFactor !== undefined ? roundQuantity(component.scrapFactor) : null,
            component.notes ?? null,
            now
          ]
        );
      }

      const bom = await fetchBomById(bomId, client);
      if (!bom) {
        throw new Error('BOM_NOT_FOUND_AFTER_CREATE');
      }
      return bom;
    });

    return res.status(201).json(createdBom);
  } catch (error: any) {
    if (error?.code === '23505') {
      if (error?.constraint === 'boms_bom_code_key') {
        return res.status(409).json({ error: 'bomCode must be unique.' });
      }
      if (error?.constraint === 'bom_version_lines_line_unique') {
        return res.status(400).json({ error: 'Component line numbers must be unique per BOM version.' });
      }
    }
    if (error?.code === '23503') {
      return res.status(400).json({ error: 'Referenced item does not exist.' });
    }
    if (error?.message === 'BOM_NOT_FOUND_AFTER_CREATE') {
      console.error(error);
      return res.status(500).json({ error: 'Failed to load BOM after creation.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create BOM.' });
  }
});

app.get('/boms/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid BOM id.' });
  }

  try {
    const bom = await fetchBomById(id);
    if (!bom) {
      return res.status(404).json({ error: 'BOM not found.' });
    }
    return res.json(bom);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load BOM.' });
  }
});

app.get('/items/:id/boms', async (req: Request, res: Response) => {
  const itemId = req.params.id;
  if (!z.string().uuid().safeParse(itemId).success) {
    return res.status(400).json({ error: 'Invalid item id.' });
  }

  try {
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
        versions: any[];
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
          updatedAt: row.version_updated_at
        });
      }
    }

    return res.json({ itemId, boms: Array.from(bomMap.values()) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list BOMs for item.' });
  }
});

app.post('/boms/:id/activate', async (req: Request, res: Response) => {
  const versionId = req.params.id;
  if (!z.string().uuid().safeParse(versionId).success) {
    return res.status(400).json({ error: 'Invalid BOM version id.' });
  }

  const parsed = bomActivationSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const effectiveFrom = parseDateInput(parsed.data.effectiveFrom);
  const effectiveTo = parsed.data.effectiveTo ? parseDateInput(parsed.data.effectiveTo) : null;
  if (!effectiveFrom) {
    return res.status(400).json({ error: 'effectiveFrom must be a valid ISO datetime.' });
  }
  if (parsed.data.effectiveTo && !effectiveTo) {
    return res.status(400).json({ error: 'effectiveTo must be a valid ISO datetime.' });
  }

  const effectiveFromIso = effectiveFrom.toISOString();
  const effectiveToIso = effectiveTo ? effectiveTo.toISOString() : null;
  const now = new Date();

  try {
    const bom = await withTransaction(async (client: PoolClient) => {
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

    return res.json(bom);
  } catch (error: any) {
    if (error?.message === 'BOM_VERSION_NOT_FOUND') {
      return res.status(404).json({ error: 'BOM version not found.' });
    }
    if (error?.message === 'BOM_VERSION_ALREADY_ACTIVE') {
      return res.status(409).json({ error: 'BOM version is already active.' });
    }
    if (error?.message === 'BOM_EFFECTIVE_RANGE_OVERLAP') {
      return res
        .status(409)
        .json({ error: 'Another BOM version is active for this item during the requested range.' });
    }
    if (error?.message === 'BOM_NOT_FOUND_AFTER_UPDATE') {
      console.error(error);
      return res.status(500).json({ error: 'Failed to load BOM after activation.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to activate BOM version.' });
  }
});

app.get('/items/:id/bom', async (req: Request, res: Response) => {
  const itemId = req.params.id;
  if (!z.string().uuid().safeParse(itemId).success) {
    return res.status(400).json({ error: 'Invalid item id.' });
  }
  const asOfParam = typeof req.query.asOf === 'string' ? req.query.asOf : undefined;
  let asOfDate: Date;
  if (asOfParam) {
    const parsedAsOf = parseDateInput(asOfParam);
    if (!parsedAsOf) {
      return res.status(400).json({ error: 'asOf must be a valid ISO datetime or date.' });
    }
    asOfDate = parsedAsOf;
  } else {
    asOfDate = new Date();
  }
  const asOfIso = asOfDate.toISOString();

  try {
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
      return res.status(404).json({ error: 'No active BOM found for the specified date.' });
    }
    const { bom_id: bomId, version_id: versionId } = rows[0];
    const bom = await fetchBomById(bomId);
    if (!bom) {
      return res.status(404).json({ error: 'BOM not found.' });
    }
    const version = bom.versions.find((v) => v.id === versionId);
    if (!version) {
      return res.status(404).json({ error: 'BOM version not found.' });
    }
    return res.json({
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
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load effective BOM.' });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err);
});

app.listen(PORT, () => {
  console.log(`Inventory Manager API listening on port ${PORT}`);
});
