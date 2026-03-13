import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { withTransactionRetry } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';

export type WorkOrderInputLotLink = {
  componentItemId: string;
  lotId: string;
  uom: string;
  quantity: number;
};

export type PreparedWorkOrderTraceability = {
  outputLotId: string;
  outputLotCode: string;
  productionBatchId: string | null;
  inputLots: WorkOrderInputLotLink[];
};

function buildAutoOutputLotCode(workOrderNumber: string, executionId: string) {
  const normalizedOrder = workOrderNumber.replace(/[^A-Za-z0-9-]/g, '').slice(0, 48) || 'WO';
  return `WO-${normalizedOrder}-${executionId.slice(0, 8).toUpperCase()}`;
}

async function resolveOrCreateOutputLot(
  client: PoolClient,
  params: {
    tenantId: string;
    outputItemId: string;
    outputLotId?: string | null;
    outputLotCode?: string | null;
    workOrderNumber: string;
    executionId: string;
    occurredAt: Date;
  }
): Promise<{ id: string; lotCode: string }> {
  if (params.outputLotId) {
    const existing = await client.query<{ id: string; item_id: string; lot_code: string }>(
      `SELECT id, item_id, lot_code
         FROM lots
        WHERE id = $1
          AND tenant_id = $2`,
      [params.outputLotId, params.tenantId]
    );
    if (!existing.rows[0]) {
      throw new Error('WO_REPORT_OUTPUT_LOT_NOT_FOUND');
    }
    if (existing.rows[0].item_id !== params.outputItemId) {
      throw new Error('WO_REPORT_OUTPUT_LOT_ITEM_MISMATCH');
    }
    return { id: existing.rows[0].id, lotCode: existing.rows[0].lot_code };
  }

  const lotCode = (
    params.outputLotCode?.trim()
    || buildAutoOutputLotCode(params.workOrderNumber, params.executionId)
  ).slice(0, 120);
  const found = await client.query<{ id: string; lot_code: string }>(
    `SELECT id, lot_code
       FROM lots
      WHERE tenant_id = $1
        AND item_id = $2
        AND lot_code = $3
      LIMIT 1`,
    [params.tenantId, params.outputItemId, lotCode]
  );
  if (found.rows[0]) {
    return { id: found.rows[0].id, lotCode: found.rows[0].lot_code };
  }

  const now = new Date();
  const lotId = uuidv4();
  try {
    const inserted = await client.query<{ id: string; lot_code: string }>(
      `INSERT INTO lots (
         id, tenant_id, item_id, lot_code, status, manufactured_at, notes, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $7)
       RETURNING id, lot_code`,
      [
        lotId,
        params.tenantId,
        params.outputItemId,
        lotCode,
        params.occurredAt,
        `Auto-created from report-production execution ${params.executionId}`,
        now
      ]
    );
    return { id: inserted.rows[0].id, lotCode: inserted.rows[0].lot_code };
  } catch (error: any) {
    if (error?.code === '23505') {
      const replayFound = await client.query<{ id: string; lot_code: string }>(
        `SELECT id, lot_code
           FROM lots
          WHERE tenant_id = $1
            AND item_id = $2
            AND lot_code = $3
          LIMIT 1`,
        [params.tenantId, params.outputItemId, lotCode]
      );
      if (replayFound.rows[0]) {
        return { id: replayFound.rows[0].id, lotCode: replayFound.rows[0].lot_code };
      }
    }
    throw error;
  }
}

export async function prepareTraceability(
  client: PoolClient,
  params: {
    tenantId: string;
    executionId: string;
    outputItemId: string;
    outputLotId?: string | null;
    outputLotCode?: string | null;
    productionBatchId?: string | null;
    inputLots?: Array<{
      componentItemId: string;
      lotId: string;
      uom: string;
      quantity: number | string;
    }> | null;
    workOrderNumber: string;
    occurredAt: Date;
  }
): Promise<PreparedWorkOrderTraceability> {
  const resolvedOutputLot = await resolveOrCreateOutputLot(client, {
    tenantId: params.tenantId,
    outputItemId: params.outputItemId,
    outputLotId: params.outputLotId ?? null,
    outputLotCode: params.outputLotCode ?? null,
    workOrderNumber: params.workOrderNumber,
    executionId: params.executionId,
    occurredAt: params.occurredAt
  });

  const normalizedInputLots = Array.isArray(params.inputLots)
    ? params.inputLots.map((inputLot) => ({
      componentItemId: inputLot.componentItemId,
      lotId: inputLot.lotId,
      uom: inputLot.uom,
      quantity: roundQuantity(toNumber(inputLot.quantity))
    }))
    : [];

  if (normalizedInputLots.length > 0) {
    const lotIds = Array.from(new Set(normalizedInputLots.map((lot) => lot.lotId)));
    const lotRows = await client.query<{ id: string; item_id: string }>(
      `SELECT id, item_id
         FROM lots
        WHERE tenant_id = $1
          AND id = ANY($2::uuid[])`,
      [params.tenantId, lotIds]
    );
    const byId = new Map(lotRows.rows.map((row) => [row.id, row]));
    for (const inputLot of normalizedInputLots) {
      const lotRow = byId.get(inputLot.lotId);
      if (!lotRow) {
        throw new Error('WO_REPORT_INPUT_LOT_NOT_FOUND');
      }
      if (lotRow.item_id !== inputLot.componentItemId) {
        throw new Error('WO_REPORT_INPUT_LOT_ITEM_MISMATCH');
      }
    }
  }

  return {
    outputLotId: resolvedOutputLot.id,
    outputLotCode: resolvedOutputLot.lotCode,
    productionBatchId: params.productionBatchId?.trim() || null,
    inputLots: normalizedInputLots
  };
}

export async function appendTraceabilityLinks(
  tenantId: string,
  params: {
    executionId: string;
    outputItemId: string;
    outputQty: number;
    outputUom: string;
    outputLotId?: string | null;
    outputLotCode?: string | null;
    inputLots?: WorkOrderInputLotLink[] | null;
  }
): Promise<{ outputLotId: string; outputLotCode: string; inputLotCount: number }> {
  return withTransactionRetry(async (client) => {
    const executionRes = await client.query<{
      id: string;
      production_movement_id: string | null;
      output_lot_id: string | null;
    }>(
      `SELECT id, production_movement_id, output_lot_id
         FROM work_order_executions
        WHERE tenant_id = $1
          AND id = $2
        FOR UPDATE`,
      [tenantId, params.executionId]
    );
    if (!executionRes.rows[0]) {
      throw new Error('WO_REPORT_EXECUTION_NOT_FOUND');
    }
    const productionMovementId = executionRes.rows[0].production_movement_id;
    if (!productionMovementId) {
      throw new Error('WO_REPORT_EXECUTION_NOT_POSTED');
    }

    let outputLotId = params.outputLotId ?? executionRes.rows[0].output_lot_id;
    if (!outputLotId && params.outputLotCode) {
      const lotByCode = await client.query<{ id: string }>(
        `SELECT id
           FROM lots
          WHERE tenant_id = $1
            AND item_id = $2
            AND lot_code = $3
          LIMIT 1`,
        [tenantId, params.outputItemId, params.outputLotCode]
      );
      outputLotId = lotByCode.rows[0]?.id ?? null;
    }
    if (!outputLotId) {
      throw new Error('WO_REPORT_OUTPUT_LOT_NOT_FOUND');
    }

    const lotRes = await client.query<{ lot_code: string }>(
      `SELECT lot_code
         FROM lots
        WHERE tenant_id = $1
          AND id = $2`,
      [tenantId, outputLotId]
    );
    if (!lotRes.rows[0]) {
      throw new Error('WO_REPORT_OUTPUT_LOT_NOT_FOUND');
    }
    const outputLotCode = params.outputLotCode ?? lotRes.rows[0].lot_code;

    const now = new Date();
    await client.query(
      `INSERT INTO work_order_lot_links (
         id, tenant_id, work_order_execution_id, role, item_id, lot_id, uom, quantity, created_at
       ) VALUES ($1, $2, $3, 'produce', $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, work_order_execution_id, role, item_id, lot_id, uom) DO NOTHING`,
      [
        uuidv4(),
        tenantId,
        params.executionId,
        params.outputItemId,
        outputLotId,
        params.outputUom,
        roundQuantity(params.outputQty),
        now
      ]
    );

    const producedLines = await client.query<{
      id: string;
      uom: string;
      quantity_delta: string | number;
    }>(
      `SELECT id, uom, quantity_delta
         FROM inventory_movement_lines
        WHERE tenant_id = $1
          AND movement_id = $2
          AND item_id = $3
          AND quantity_delta > 0
        ORDER BY id`,
      [tenantId, productionMovementId, params.outputItemId]
    );
    if ((producedLines.rowCount ?? 0) === 0) {
      throw new Error('WO_REPORT_OUTPUT_MOVEMENT_LINES_MISSING');
    }

    for (const producedLine of producedLines.rows) {
      await client.query(
        `INSERT INTO inventory_movement_lots (
           id, tenant_id, inventory_movement_line_id, lot_id, uom, quantity_delta, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, inventory_movement_line_id, lot_id) DO NOTHING`,
        [
          uuidv4(),
          tenantId,
          producedLine.id,
          outputLotId,
          producedLine.uom,
          roundQuantity(toNumber(producedLine.quantity_delta)),
          now
        ]
      );
    }

    const normalizedInputLots = Array.isArray(params.inputLots) ? params.inputLots : [];
    for (const inputLot of normalizedInputLots) {
      await client.query(
        `INSERT INTO work_order_lot_links (
           id, tenant_id, work_order_execution_id, role, item_id, lot_id, uom, quantity, created_at
         ) VALUES ($1, $2, $3, 'consume', $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, work_order_execution_id, role, item_id, lot_id, uom) DO NOTHING`,
        [
          uuidv4(),
          tenantId,
          params.executionId,
          inputLot.componentItemId,
          inputLot.lotId,
          inputLot.uom,
          roundQuantity(toNumber(inputLot.quantity)),
          now
        ]
      );
    }

    return {
      outputLotId,
      outputLotCode,
      inputLotCount: normalizedInputLots.length
    };
  });
}

export function isNonRetryableLotLinkError(error: unknown) {
  const lotError = error as Error & { code?: string };
  const code = lotError?.code;
  const message = lotError?.message;
  return (
    code === 'WO_REPORT_OUTPUT_LOT_NOT_FOUND'
    || message === 'WO_REPORT_OUTPUT_LOT_NOT_FOUND'
    || code === 'WO_REPORT_OUTPUT_LOT_ITEM_MISMATCH'
    || message === 'WO_REPORT_OUTPUT_LOT_ITEM_MISMATCH'
    || code === 'WO_REPORT_INPUT_LOT_NOT_FOUND'
    || message === 'WO_REPORT_INPUT_LOT_NOT_FOUND'
    || code === 'WO_REPORT_INPUT_LOT_ITEM_MISMATCH'
    || message === 'WO_REPORT_INPUT_LOT_ITEM_MISMATCH'
  );
}
