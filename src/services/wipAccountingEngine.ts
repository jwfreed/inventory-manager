import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { roundQuantity, toNumber } from '../lib/numbers';
import type { WipValuationType } from './workOrderExecution.types';

export const WIP_COST_METHOD = 'fifo';
const WIP_INTEGRITY_EPSILON = 1e-6;

export type WorkOrderWipValuationRecordRow = {
  id: string;
  tenant_id: string;
  work_order_id: string;
  work_order_execution_id: string | null;
  inventory_movement_id: string;
  valuation_type: WipValuationType;
  value_delta: string | number;
  quantity_canonical: string | number | null;
  canonical_uom: string | null;
  cost_method: string | null;
  reversal_of_valuation_record_id: string | null;
  notes: string | null;
  created_at: string;
};

export type PendingWipCostAllocation = {
  consumptionIds: string[];
  totalCost: number;
};

function workOrderWipIntegrityError(details: Record<string, unknown>) {
  const error = new Error('WO_WIP_INTEGRITY_FAILED') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = 'WO_WIP_INTEGRITY_FAILED';
  error.details = details;
  return error;
}

export async function createWipValuationRecord(
  client: PoolClient,
  params: {
    tenantId: string;
    workOrderId: string;
    executionId?: string | null;
    movementId: string;
    valuationType: WipValuationType;
    valueDelta: number;
    quantityCanonical?: number | null;
    canonicalUom?: string | null;
    reversalOfValuationRecordId?: string | null;
    notes?: string | null;
  }
) {
  const insertResult = await client.query<WorkOrderWipValuationRecordRow>(
    `INSERT INTO work_order_wip_valuation_records (
        id,
        tenant_id,
        work_order_id,
        work_order_execution_id,
        inventory_movement_id,
        valuation_type,
        value_delta,
        quantity_canonical,
        canonical_uom,
        cost_method,
        reversal_of_valuation_record_id,
        notes,
        created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (tenant_id, inventory_movement_id, valuation_type) DO NOTHING
     RETURNING *`,
    [
      uuidv4(),
      params.tenantId,
      params.workOrderId,
      params.executionId ?? null,
      params.movementId,
      params.valuationType,
      roundQuantity(params.valueDelta),
      params.quantityCanonical != null ? roundQuantity(params.quantityCanonical) : null,
      params.canonicalUom ?? null,
      WIP_COST_METHOD,
      params.reversalOfValuationRecordId ?? null,
      params.notes ?? null,
      new Date()
    ]
  );
  if ((insertResult.rowCount ?? 0) > 0) {
    return insertResult.rows[0];
  }
  const existing = await client.query<WorkOrderWipValuationRecordRow>(
    `SELECT *
       FROM work_order_wip_valuation_records
      WHERE tenant_id = $1
        AND inventory_movement_id = $2
        AND valuation_type = $3
      LIMIT 1`,
    [params.tenantId, params.movementId, params.valuationType]
  );
  if (existing.rowCount === 0) {
    throw new Error('WO_WIP_VALUATION_RECORD_MISSING');
  }
  return existing.rows[0];
}

export async function loadWipValuationRecordsByMovementIds(
  client: PoolClient,
  tenantId: string,
  movementIds: string[]
) {
  if (movementIds.length === 0) {
    return [];
  }
  const result = await client.query<WorkOrderWipValuationRecordRow>(
    `SELECT *
       FROM work_order_wip_valuation_records
      WHERE tenant_id = $1
        AND inventory_movement_id = ANY($2::uuid[])
      ORDER BY valuation_type ASC, inventory_movement_id ASC, created_at ASC, id ASC`,
    [tenantId, movementIds]
  );
  return result.rows;
}

export async function verifyWipIntegrity(
  client: PoolClient,
  tenantId: string,
  workOrderId: string
) {
  const result = await client.query<Pick<WorkOrderWipValuationRecordRow, 'valuation_type' | 'value_delta'>>(
    `SELECT valuation_type, value_delta
       FROM work_order_wip_valuation_records
      WHERE tenant_id = $1
        AND work_order_id = $2
      ORDER BY created_at ASC, id ASC
      FOR UPDATE`,
    [tenantId, workOrderId]
  );

  let issueValue = 0;
  let completionConsumptionValue = 0;
  let reversalToWipValue = 0;
  let reversalFromWipValue = 0;
  let signedLedgerBalance = 0;

  for (const row of result.rows) {
    const valueDelta = roundQuantity(toNumber(row.value_delta));
    signedLedgerBalance += valueDelta;
    switch (row.valuation_type) {
      case 'issue':
        if (valueDelta < -WIP_INTEGRITY_EPSILON) {
          throw workOrderWipIntegrityError({
            tenantId,
            workOrderId,
            reason: 'issue_value_delta_negative',
            valuationType: row.valuation_type,
            valueDelta
          });
        }
        issueValue += valueDelta;
        break;
      case 'completion':
      case 'report':
        if (valueDelta > WIP_INTEGRITY_EPSILON) {
          throw workOrderWipIntegrityError({
            tenantId,
            workOrderId,
            reason: 'completion_value_delta_positive',
            valuationType: row.valuation_type,
            valueDelta
          });
        }
        completionConsumptionValue += Math.abs(valueDelta);
        break;
      case 'reversal_to_wip':
        if (valueDelta < -WIP_INTEGRITY_EPSILON) {
          throw workOrderWipIntegrityError({
            tenantId,
            workOrderId,
            reason: 'reversal_to_wip_negative',
            valuationType: row.valuation_type,
            valueDelta
          });
        }
        reversalToWipValue += valueDelta;
        break;
      case 'reversal_from_wip':
        if (valueDelta > WIP_INTEGRITY_EPSILON) {
          throw workOrderWipIntegrityError({
            tenantId,
            workOrderId,
            reason: 'reversal_from_wip_positive',
            valuationType: row.valuation_type,
            valueDelta
          });
        }
        reversalFromWipValue += Math.abs(valueDelta);
        break;
      default:
        throw workOrderWipIntegrityError({
          tenantId,
          workOrderId,
          reason: 'valuation_type_unrecognized',
          valuationType: row.valuation_type
        });
    }
  }

  const expectedWipBalance = roundQuantity(
    issueValue + reversalToWipValue - completionConsumptionValue - reversalFromWipValue
  );
  const normalizedSignedLedgerBalance = roundQuantity(signedLedgerBalance);
  if (Math.abs(expectedWipBalance - normalizedSignedLedgerBalance) > WIP_INTEGRITY_EPSILON) {
    throw workOrderWipIntegrityError({
      tenantId,
      workOrderId,
      reason: 'signed_wip_balance_mismatch',
      expectedWipBalance,
      actualWipBalance: normalizedSignedLedgerBalance,
      issueValue,
      completionConsumptionValue,
      reversalToWipValue,
      reversalFromWipValue
    });
  }
  if (normalizedSignedLedgerBalance < -WIP_INTEGRITY_EPSILON) {
    throw workOrderWipIntegrityError({
      tenantId,
      workOrderId,
      reason: 'negative_wip_balance',
      actualWipBalance: normalizedSignedLedgerBalance,
      issueValue,
      completionConsumptionValue,
      reversalToWipValue,
      reversalFromWipValue
    });
  }

  return {
    issueValue,
    completionConsumptionValue,
    reversalToWipValue,
    reversalFromWipValue,
    wipBalance: normalizedSignedLedgerBalance
  };
}

async function lockOpenWipFromMovement(
  client: PoolClient,
  tenantId: string,
  movementId: string
): Promise<PendingWipCostAllocation> {
  const rows = await client.query<{ id: string; extended_cost: string | number }>(
    `SELECT id, extended_cost
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND movement_id = $2
        AND consumption_type = 'production_input'
        AND wip_execution_id IS NULL
      FOR UPDATE`,
    [tenantId, movementId]
  );

  if (rows.rowCount === 0) {
    throw new Error('WO_WIP_COST_NO_CONSUMPTIONS');
  }

  return {
    consumptionIds: rows.rows.map((row) => row.id),
    totalCost: rows.rows.reduce((sum, row) => sum + toNumber(row.extended_cost), 0)
  };
}

async function lockOpenWipFromWorkOrder(
  client: PoolClient,
  tenantId: string,
  workOrderId: string
): Promise<PendingWipCostAllocation> {
  const rows = await client.query<{ id: string; extended_cost: string | number }>(
    `SELECT clc.id, clc.extended_cost
       FROM cost_layer_consumptions clc
       JOIN work_order_material_issues wmi
         ON wmi.id = clc.consumption_document_id
        AND wmi.tenant_id = clc.tenant_id
      WHERE wmi.work_order_id = $1
        AND wmi.status = 'posted'
        AND clc.tenant_id = $2
        AND clc.consumption_type = 'production_input'
        AND clc.wip_execution_id IS NULL
      FOR UPDATE OF clc`,
    [workOrderId, tenantId]
  );

  if (rows.rowCount === 0) {
    throw new Error('WO_WIP_COST_NO_CONSUMPTIONS');
  }

  return {
    consumptionIds: rows.rows.map((row) => row.id),
    totalCost: rows.rows.reduce((sum, row) => sum + toNumber(row.extended_cost), 0)
  };
}

export async function lockOpenWip(
  client: PoolClient,
  params:
    | { tenantId: string; scope: { kind: 'movement'; movementId: string } }
    | { tenantId: string; scope: { kind: 'workOrder'; workOrderId: string } }
) {
  if (params.scope.kind === 'movement') {
    return lockOpenWipFromMovement(client, params.tenantId, params.scope.movementId);
  }
  return lockOpenWipFromWorkOrder(client, params.tenantId, params.scope.workOrderId);
}

export async function allocateWipCost(
  client: PoolClient,
  params: {
    tenantId: string;
    executionId: string;
    allocatedAt: Date;
    pending: PendingWipCostAllocation;
  }
) {
  await client.query(
    `UPDATE cost_layer_consumptions
        SET wip_execution_id = $1,
            wip_allocated_at = $2
      WHERE tenant_id = $3
        AND id = ANY($4::uuid[])`,
    [params.executionId, params.allocatedAt, params.tenantId, params.pending.consumptionIds]
  );
  return params.pending.totalCost;
}

export async function reverseWipCost(
  client: PoolClient,
  params: {
    tenantId: string;
    workOrderId: string;
    executionId: string;
    originalIssueMovementId: string;
    originalReportMovementId: string;
    outputMovementId: string;
    componentMovementId: string;
    outputReversalCost: number;
    componentReturnCost: number;
  }
) {
  const originalValuationRecords = await loadWipValuationRecordsByMovementIds(
    client,
    params.tenantId,
    [params.originalIssueMovementId, params.originalReportMovementId]
  );
  const originalIssueValuation = originalValuationRecords.find((row) => row.valuation_type === 'issue');
  const originalReportValuation = originalValuationRecords.find(
    (row) => row.valuation_type === 'report' || row.valuation_type === 'completion'
  );
  await createWipValuationRecord(client, {
    tenantId: params.tenantId,
    workOrderId: params.workOrderId,
    executionId: params.executionId,
    movementId: params.outputMovementId,
    valuationType: 'reversal_to_wip',
    valueDelta: params.outputReversalCost,
    reversalOfValuationRecordId: originalReportValuation?.id ?? null,
    notes: `Work-order reversal moves finished-goods value back into WIP for execution ${params.executionId}`
  });
  await createWipValuationRecord(client, {
    tenantId: params.tenantId,
    workOrderId: params.workOrderId,
    executionId: params.executionId,
    movementId: params.componentMovementId,
    valuationType: 'reversal_from_wip',
    valueDelta: -params.componentReturnCost,
    reversalOfValuationRecordId: originalIssueValuation?.id ?? null,
    notes: `Work-order reversal returns component value out of WIP for execution ${params.executionId}`
  });
  await verifyWipIntegrity(client, params.tenantId, params.workOrderId);
}
