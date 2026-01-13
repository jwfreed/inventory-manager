import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { fetchBomById } from './boms.service';
import { recordAuditLog } from '../lib/audit';
import { validateSufficientStock } from './stockValidation.service';
import { consumeCostLayers, createCostLayer } from './costLayers.service';
import { getCanonicalMovementFields, type CanonicalMovementFields } from './uomCanonical.service';
import {
  workOrderCompletionCreateSchema,
  workOrderIssueCreateSchema,
  workOrderBatchSchema
} from '../schemas/workOrderExecution.schema';

// Disassembly/rework is modeled as work_orders.kind = 'disassembly' and posts issue/receive movements
// (never inventory_adjustments). External refs include work order ids for traceability.

type WorkOrderIssueCreateInput = z.infer<typeof workOrderIssueCreateSchema>;
type WorkOrderCompletionCreateInput = z.infer<typeof workOrderCompletionCreateSchema>;
type WorkOrderBatchInput = z.infer<typeof workOrderBatchSchema>;

const WIP_COST_METHOD = 'fifo';

type NegativeOverrideContext = {
  actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
  overrideRequested?: boolean;
  overrideReason?: string | null;
};

type WorkOrderRow = {
  id: string;
  work_order_number: string;
  number: string | null;
  status: string;
  kind: string;
  bom_id: string | null;
  bom_version_id: string | null;
  output_item_id: string;
  output_uom: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
  completed_at: string | null;
  updated_at: string;
};

type WorkOrderMaterialIssueRow = {
  id: string;
  work_order_id: string;
  status: string;
  occurred_at: string;
  inventory_movement_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type WorkOrderMaterialIssueLineRow = {
  id: string;
  work_order_material_issue_id: string;
  line_number: number;
  component_item_id: string;
  uom: string;
  quantity_issued: string | number;
  from_location_id: string;
  reason_code: string | null;
  notes: string | null;
  created_at: string;
};

type WorkOrderExecutionRow = {
  id: string;
  work_order_id: string;
  occurred_at: string;
  status: string;
  consumption_movement_id: string | null;
  production_movement_id: string | null;
  wip_total_cost: string | number | null;
  wip_unit_cost: string | number | null;
  wip_quantity_canonical: string | number | null;
  wip_cost_method: string | null;
  wip_costed_at: string | null;
  notes: string | null;
  created_at: string;
};

type WorkOrderExecutionLineRow = {
  id: string;
  work_order_execution_id: string;
  line_type: string;
  item_id: string;
  uom: string;
  quantity: string | number;
  pack_size: string | number | null;
  from_location_id: string | null;
  to_location_id: string | null;
  reason_code: string | null;
  notes: string | null;
  created_at: string;
};

function mapMaterialIssue(row: WorkOrderMaterialIssueRow, lines: WorkOrderMaterialIssueLineRow[]) {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    status: row.status,
    occurredAt: row.occurred_at,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      lineNumber: line.line_number,
      componentItemId: line.component_item_id,
      fromLocationId: line.from_location_id,
      uom: line.uom,
      quantityIssued: roundQuantity(toNumber(line.quantity_issued)),
      reasonCode: line.reason_code,
      notes: line.notes,
      createdAt: line.created_at
    }))
  };
}

function mapExecution(row: WorkOrderExecutionRow, lines: WorkOrderExecutionLineRow[]) {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    status: row.status,
    occurredAt: row.occurred_at,
    consumptionMovementId: row.consumption_movement_id,
    productionMovementId: row.production_movement_id,
    wipTotalCost: row.wip_total_cost !== null ? toNumber(row.wip_total_cost) : null,
    wipUnitCost: row.wip_unit_cost !== null ? toNumber(row.wip_unit_cost) : null,
    wipQuantityCanonical: row.wip_quantity_canonical !== null ? toNumber(row.wip_quantity_canonical) : null,
    wipCostMethod: row.wip_cost_method ?? null,
    wipCostedAt: row.wip_costed_at ?? null,
    notes: row.notes,
    createdAt: row.created_at,
    lines: lines.map((line) => ({
      id: line.id,
      lineType: line.line_type,
      itemId: line.item_id,
      uom: line.uom,
      quantity: roundQuantity(toNumber(line.quantity)),
      packSize: line.pack_size !== null ? roundQuantity(toNumber(line.pack_size)) : null,
      fromLocationId: line.from_location_id,
      toLocationId: line.to_location_id,
      reasonCode: line.reason_code,
      notes: line.notes,
      createdAt: line.created_at
    }))
  };
}

async function fetchWorkOrderById(
  tenantId: string,
  id: string,
  client?: PoolClient
): Promise<WorkOrderRow | null> {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId
  ]);
  return result.rowCount === 0 ? null : result.rows[0];
}

async function allocateWipCostFromMovement(
  client: PoolClient,
  tenantId: string,
  executionId: string,
  movementId: string,
  allocatedAt: Date
): Promise<number> {
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

  const ids = rows.rows.map((row) => row.id);
  const totalCost = rows.rows.reduce((sum, row) => sum + toNumber(row.extended_cost), 0);

  await client.query(
    `UPDATE cost_layer_consumptions
        SET wip_execution_id = $1,
            wip_allocated_at = $2
      WHERE tenant_id = $3
        AND id = ANY($4::uuid[])`,
    [executionId, allocatedAt, tenantId, ids]
  );

  return totalCost;
}

async function allocateWipCostFromWorkOrderIssues(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  executionId: string,
  allocatedAt: Date
): Promise<number> {
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

  const ids = rows.rows.map((row) => row.id);
  const totalCost = rows.rows.reduce((sum, row) => sum + toNumber(row.extended_cost), 0);

  await client.query(
    `UPDATE cost_layer_consumptions
        SET wip_execution_id = $1,
            wip_allocated_at = $2
      WHERE tenant_id = $3
        AND id = ANY($4::uuid[])`,
    [executionId, allocatedAt, tenantId, ids]
  );

  return totalCost;
}

export async function createWorkOrderIssue(tenantId: string, workOrderId: string, data: WorkOrderIssueCreateInput) {
  const lineNumbers = new Set<number>();
  const normalizedLines = data.lines.map((line, index) => {
    const lineNumber = line.lineNumber ?? index + 1;
    if (lineNumbers.has(lineNumber)) {
      throw new Error('WO_ISSUE_DUPLICATE_LINE');
    }
    const quantityIssued = toNumber(line.quantityIssued);
    lineNumbers.add(lineNumber);
    return {
      lineNumber,
      componentItemId: line.componentItemId,
      fromLocationId: line.fromLocationId,
      uom: line.uom,
      quantityIssued,
      reasonCode: line.reasonCode ?? null,
      notes: line.notes ?? null
    };
  });

  const issueId = uuidv4();
  const now = new Date();

  return withTransaction(async (client) => {
    const workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }

    await client.query(
      `INSERT INTO work_order_material_issues (
          id, tenant_id, work_order_id, status, occurred_at, inventory_movement_id, notes, created_at, updated_at
       ) VALUES ($1, $2, $3, 'draft', $4, NULL, $5, $6, $6)`,
      [issueId, tenantId, workOrderId, new Date(data.occurredAt), data.notes ?? null, now]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO work_order_material_issue_lines (
            id, tenant_id, work_order_material_issue_id, line_number, component_item_id, uom, quantity_issued, from_location_id, reason_code, notes, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          uuidv4(),
          tenantId,
          issueId,
          line.lineNumber,
          line.componentItemId,
          line.uom,
          line.quantityIssued,
          line.fromLocationId,
          line.reasonCode,
          line.notes,
          now
        ]
      );
    }

    const issue = await fetchWorkOrderIssue(tenantId, workOrderId, issueId, client);
    if (!issue) {
      throw new Error('WO_ISSUE_NOT_FOUND_AFTER_CREATE');
    }
    return issue;
  });
}

export async function fetchWorkOrderIssue(
  tenantId: string,
  workOrderId: string,
  issueId: string,
  client?: PoolClient
) {
  const executor = client ? client.query.bind(client) : query;
  const headerResult = await executor<WorkOrderMaterialIssueRow>(
    'SELECT * FROM work_order_material_issues WHERE id = $1 AND work_order_id = $2 AND tenant_id = $3',
    [issueId, workOrderId, tenantId]
  );
  if (headerResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor<WorkOrderMaterialIssueLineRow>(
    'SELECT * FROM work_order_material_issue_lines WHERE work_order_material_issue_id = $1 AND tenant_id = $2 ORDER BY line_number ASC',
    [issueId, tenantId]
  );
  return mapMaterialIssue(headerResult.rows[0], linesResult.rows);
}

export async function postWorkOrderIssue(
  tenantId: string,
  workOrderId: string,
  issueId: string,
  context: NegativeOverrideContext = {}
) {
  return withTransaction(async (client) => {
    const workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    const isDisassembly = workOrder.kind === 'disassembly';
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }

    const issueResult = await client.query<WorkOrderMaterialIssueRow>(
      'SELECT * FROM work_order_material_issues WHERE id = $1 AND work_order_id = $2 AND tenant_id = $3 FOR UPDATE',
      [issueId, workOrderId, tenantId]
    );
    if (issueResult.rowCount === 0) {
      throw new Error('WO_ISSUE_NOT_FOUND');
    }
    const issue = issueResult.rows[0];
    if (issue.status === 'posted') {
      throw new Error('WO_ISSUE_ALREADY_POSTED');
    }
    if (issue.status === 'canceled') {
      throw new Error('WO_ISSUE_CANCELED');
    }

    const linesResult = await client.query<WorkOrderMaterialIssueLineRow>(
      'SELECT * FROM work_order_material_issue_lines WHERE work_order_material_issue_id = $1 AND tenant_id = $2 ORDER BY line_number ASC',
      [issueId, tenantId]
    );
    if (linesResult.rowCount === 0) {
      throw new Error('WO_ISSUE_NO_LINES');
    }

    const now = new Date();
    const occurredAt = new Date(issue.occurred_at);
    const validation = await validateSufficientStock(
      tenantId,
      occurredAt,
      linesResult.rows.map((line) => ({
        itemId: line.component_item_id,
        locationId: line.from_location_id,
        uom: line.uom,
        quantityToConsume: roundQuantity(toNumber(line.quantity_issued))
      })),
      {
        actorId: context.actor?.id ?? null,
        actorRole: context.actor?.role ?? null,
        overrideRequested: context.overrideRequested,
        overrideReason: context.overrideReason ?? null
      }
    );
    const workOrderNumber = workOrder.number ?? workOrder.work_order_number;
    const movementMetadata = {
      workOrderId,
      workOrderNumber,
      ...(validation.overrideMetadata ?? {})
    };
    const movementId = uuidv4();
    await client.query(
      `INSERT INTO inventory_movements (
          id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, metadata, created_at, updated_at
       ) VALUES ($1, $2, 'issue', 'posted', $3, $4, $5, $6, $7, $5, $5)`,
      [
        movementId,
        tenantId,
        isDisassembly
          ? `work_order_disassembly_issue:${issueId}:${workOrderId}`
          : `work_order_issue:${issueId}:${workOrderId}`,
        occurredAt,
        now,
        issue.notes ?? null,
        movementMetadata
      ]
    );

    const issuedTotal = linesResult.rows.reduce((sum, line) => {
      const qty = toNumber(line.quantity_issued);
      return sum + qty;
    }, 0);

    for (const line of linesResult.rows) {
      if (isDisassembly && line.component_item_id !== workOrder.output_item_id) {
        throw new Error('WO_DISASSEMBLY_INPUT_MISMATCH');
      }
      const qty = toNumber(line.quantity_issued);
      if (qty <= 0) {
        throw new Error('WO_ISSUE_INVALID_QUANTITY');
      }
      const reasonCode = line.reason_code ?? (isDisassembly ? 'disassembly_issue' : 'work_order_issue');
      
      const canonicalFields = await getCanonicalMovementFields(
        tenantId,
        line.component_item_id,
        -qty,
        line.uom,
        client
      );
      
      // Consume from cost layers for material issue
      let issueCost = null as number | null;
      try {
        const consumption = await consumeCostLayers({
          tenant_id: tenantId,
          item_id: line.component_item_id,
          location_id: line.from_location_id,
          quantity: qty,
          consumption_type: 'production_input',
          consumption_document_id: issueId,
          movement_id: movementId,
          client
        });
        issueCost = consumption.total_cost;
      } catch {
        throw new Error('WO_WIP_COST_LAYERS_MISSING');
      }
      const unitCost = issueCost !== null && qty !== 0 ? issueCost / qty : null;
      const extendedCost = issueCost !== null ? -issueCost : null;
      
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom,
            quantity_delta_entered, uom_entered, quantity_delta_canonical, canonical_uom, uom_dimension,
            unit_cost, extended_cost, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          uuidv4(),
          tenantId,
          movementId,
          line.component_item_id,
          line.from_location_id,
          -qty,
          line.uom,
          canonicalFields.quantityDeltaEntered,
          canonicalFields.uomEntered,
          canonicalFields.quantityDeltaCanonical,
          canonicalFields.canonicalUom,
          canonicalFields.uomDimension,
          unitCost,
          extendedCost,
          reasonCode,
          line.notes ?? `Work order issue ${issueId} line ${line.line_number}`
        ]
      );
    }

    await client.query(
      `UPDATE work_order_material_issues
          SET status = 'posted',
              inventory_movement_id = $1,
              updated_at = $2
        WHERE id = $3 AND tenant_id = $4`,
      [movementId, now, issueId, tenantId]
    );

    if (workOrder.status === 'draft') {
      await client.query(
        `UPDATE work_orders SET status = 'in_progress', updated_at = $2 WHERE id = $1 AND tenant_id = $3`,
        [workOrderId, now, tenantId]
      );
    }

    if (isDisassembly) {
      const currentCompleted = toNumber(workOrder.quantity_completed ?? 0);
      const newCompleted = currentCompleted + issuedTotal;
      const planned = toNumber(workOrder.quantity_planned);
      const completedAt = newCompleted >= planned ? now : null;
      const nextStatus = newCompleted >= planned ? 'completed' : workOrder.status === 'draft' ? 'in_progress' : workOrder.status;
      await client.query(
        `UPDATE work_orders
            SET quantity_completed = $2,
                status = $3,
                completed_at = COALESCE(completed_at, $4),
                updated_at = $5
          WHERE id = $1 AND tenant_id = $6`,
        [workOrderId, newCompleted, nextStatus, completedAt, now, tenantId]
      );
    }

    if (validation.overrideMetadata && context.actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: context.actor.type,
          actorId: context.actor.id ?? null,
          action: 'negative_override',
          entityType: 'inventory_movement',
          entityId: movementId,
          occurredAt: now,
          metadata: {
            reason: validation.overrideMetadata.override_reason ?? null,
            workOrderId,
            issueId,
            lines: linesResult.rows.map((line) => ({
              itemId: line.component_item_id,
              locationId: line.from_location_id,
              uom: line.uom,
              quantity: roundQuantity(toNumber(line.quantity_issued))
            }))
          }
        },
        client
      );
    }

    const posted = await fetchWorkOrderIssue(tenantId, workOrderId, issueId, client);
    if (!posted) {
      throw new Error('WO_ISSUE_NOT_FOUND_AFTER_POST');
    }
    return posted;
  });
}

export async function createWorkOrderCompletion(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderCompletionCreateInput
) {
  const executionId = uuidv4();
  const now = new Date();
  const normalizedLines = data.lines.map((line) => ({
    ...line,
    uom: line.uom,
    quantityCompleted: toNumber(line.quantityCompleted)
  }));

  return withTransaction(async (client) => {
    const workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }

    await client.query(
      `INSERT INTO work_order_executions (
          id, tenant_id, work_order_id, occurred_at, status, consumption_movement_id, production_movement_id, notes, created_at
       ) VALUES ($1, $2, $3, $4, 'draft', NULL, NULL, $5, $6)`,
      [executionId, tenantId, workOrderId, new Date(data.occurredAt), data.notes ?? null, now]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO work_order_execution_lines (
            id, tenant_id, work_order_execution_id, line_type, item_id, uom, quantity, pack_size, from_location_id, to_location_id, reason_code, notes, created_at
         ) VALUES ($1, $2, $3, 'produce', $4, $5, $6, $7, NULL, $8, $9, $10, $11)`,
        [
          uuidv4(),
          tenantId,
          executionId,
          line.outputItemId,
          line.uom,
          line.quantityCompleted,
          line.packSize ?? null,
          line.toLocationId,
          line.reasonCode ?? null,
          line.notes ?? null,
          now
        ]
      );
    }

    const created = await fetchWorkOrderCompletion(tenantId, workOrderId, executionId, client);
    if (!created) {
      throw new Error('WO_COMPLETION_NOT_FOUND_AFTER_CREATE');
    }
    return created;
  });
}

export async function fetchWorkOrderCompletion(
  tenantId: string,
  workOrderId: string,
  completionId: string,
  client?: PoolClient
) {
  const executor = client ? client.query.bind(client) : query;
  const headerResult = await executor<WorkOrderExecutionRow>(
    'SELECT * FROM work_order_executions WHERE id = $1 AND work_order_id = $2 AND tenant_id = $3',
    [completionId, workOrderId, tenantId]
  );
  if (headerResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor<WorkOrderExecutionLineRow>(
    'SELECT * FROM work_order_execution_lines WHERE work_order_execution_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
    [completionId, tenantId]
  );
  return mapExecution(headerResult.rows[0], linesResult.rows);
}

export async function postWorkOrderCompletion(
  tenantId: string,
  workOrderId: string,
  completionId: string
) {
  return withTransaction(async (client) => {
    const workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    const isDisassembly = workOrder.kind === 'disassembly';
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }

    const execResult = await client.query<WorkOrderExecutionRow>(
      'SELECT * FROM work_order_executions WHERE id = $1 AND work_order_id = $2 AND tenant_id = $3 FOR UPDATE',
      [completionId, workOrderId, tenantId]
    );
    if (execResult.rowCount === 0) {
      throw new Error('WO_COMPLETION_NOT_FOUND');
    }
    const execution = execResult.rows[0];
    if (execution.status === 'posted') {
      throw new Error('WO_COMPLETION_ALREADY_POSTED');
    }
    if (execution.status === 'canceled') {
      throw new Error('WO_COMPLETION_CANCELED');
    }

    const linesResult = await client.query<WorkOrderExecutionLineRow>(
      'SELECT * FROM work_order_execution_lines WHERE work_order_execution_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
      [completionId, tenantId]
    );
    if (linesResult.rowCount === 0) {
      throw new Error('WO_COMPLETION_NO_LINES');
    }

    for (const line of linesResult.rows) {
      if (line.line_type !== 'produce') {
        throw new Error('WO_COMPLETION_INVALID_LINE_TYPE');
      }
      if (!isDisassembly && line.item_id !== workOrder.output_item_id) {
        throw new Error('WO_COMPLETION_ITEM_MISMATCH');
      }
      if (!line.to_location_id) {
        throw new Error('WO_COMPLETION_LOCATION_REQUIRED');
      }
      const qty = toNumber(line.quantity);
      if (qty <= 0) {
        throw new Error('WO_COMPLETION_INVALID_QUANTITY');
      }
    }

    const now = new Date();
    const workOrderNumber = workOrder.number ?? workOrder.work_order_number;
    const movementId = uuidv4();
    await client.query(
      `INSERT INTO inventory_movements (
          id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, metadata, created_at, updated_at
       ) VALUES ($1, $2, 'receive', 'posted', $3, $4, $5, $6, $7, $5, $5)`,
      [
        movementId,
        tenantId,
        isDisassembly
          ? `work_order_disassembly_completion:${completionId}:${workOrderId}`
          : `work_order_completion:${completionId}:${workOrderId}`,
        execution.occurred_at,
        now,
        execution.notes ?? null,
        { workOrderId, workOrderNumber }
      ]
    );

    const preparedLines: Array<{
      line: WorkOrderExecutionLineRow;
      qty: number;
      canonicalFields: CanonicalMovementFields;
    }> = [];
    let totalProduced = 0;
    let totalProducedCanonical = 0;

    for (const line of linesResult.rows) {
      const qty = toNumber(line.quantity);
      const canonicalFields = await getCanonicalMovementFields(
        tenantId,
        line.item_id,
        qty,
        line.uom,
        client
      );
      totalProduced += qty;
      totalProducedCanonical += canonicalFields.quantityDeltaCanonical;
      preparedLines.push({ line, qty, canonicalFields });
    }

    if (totalProducedCanonical <= 0) {
      throw new Error('WO_WIP_COST_INVALID_OUTPUT_QTY');
    }

    const totalIssueCost = await allocateWipCostFromWorkOrderIssues(
      client,
      tenantId,
      workOrderId,
      completionId,
      now
    );
    const wipUnitCostCanonical = totalIssueCost / totalProducedCanonical;

    for (const { line, qty, canonicalFields } of preparedLines) {
      const reasonCode = line.reason_code ?? (isDisassembly ? 'disassembly_completion' : 'work_order_completion');
      const allocationRatio = canonicalFields.quantityDeltaCanonical / totalProducedCanonical;
      const allocatedCost = totalIssueCost * allocationRatio;
      const unitCost = qty !== 0 ? allocatedCost / qty : null;
      const extendedCost = allocatedCost;

      // Create cost layer for completed production output
      if (line.to_location_id) {
        await createCostLayer({
          tenant_id: tenantId,
          item_id: line.item_id,
          location_id: line.to_location_id,
          uom: line.uom,
          quantity: qty,
          unit_cost: unitCost ?? 0,
          source_type: 'production',
          source_document_id: completionId,
          movement_id: movementId,
          notes: `Production output from work order ${workOrderId}`,
          client
        });
      }

      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom,
            quantity_delta_entered, uom_entered, quantity_delta_canonical, canonical_uom, uom_dimension,
            unit_cost, extended_cost, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          uuidv4(),
          tenantId,
          movementId,
          line.item_id,
          line.to_location_id,
          qty,
          line.uom,
          canonicalFields.quantityDeltaEntered,
          canonicalFields.uomEntered,
          canonicalFields.quantityDeltaCanonical,
          canonicalFields.canonicalUom,
          canonicalFields.uomDimension,
          unitCost,
          extendedCost,
          reasonCode,
          line.notes ?? `Work order completion ${completionId}`
        ]
      );
    }

    await client.query(
      `UPDATE work_order_executions
          SET status = 'posted',
              production_movement_id = $1,
              wip_total_cost = $2,
              wip_unit_cost = $3,
              wip_quantity_canonical = $4,
              wip_cost_method = $5,
              wip_costed_at = $6
        WHERE id = $7 AND tenant_id = $8`,
      [
        movementId,
        totalIssueCost,
        wipUnitCostCanonical,
        totalProducedCanonical,
        WIP_COST_METHOD,
        now,
        completionId,
        tenantId
      ]
    );

    if (!isDisassembly) {
      const currentCompleted = toNumber(workOrder.quantity_completed ?? 0);
      const newCompleted = currentCompleted + totalProduced;
      const planned = toNumber(workOrder.quantity_planned);
      const completedAt = newCompleted >= planned ? now : null;
      const newStatus = newCompleted >= planned ? 'completed' : workOrder.status === 'draft' ? 'in_progress' : workOrder.status;

      await client.query(
        `UPDATE work_orders
            SET quantity_completed = $2,
                status = $3,
                completed_at = COALESCE(completed_at, $4),
                wip_total_cost = COALESCE(wip_total_cost, 0) + $5,
                wip_quantity_canonical = COALESCE(wip_quantity_canonical, 0) + $6,
                wip_unit_cost = CASE
                  WHEN (COALESCE(wip_quantity_canonical, 0) + $6) > 0
                  THEN (COALESCE(wip_total_cost, 0) + $5) / (COALESCE(wip_quantity_canonical, 0) + $6)
                  ELSE NULL
                END,
                wip_cost_method = $7,
                wip_costed_at = $8,
                updated_at = $9
          WHERE id = $1 AND tenant_id = $10`,
        [
          workOrderId,
          newCompleted,
          newStatus,
          completedAt,
          totalIssueCost,
          totalProducedCanonical,
          WIP_COST_METHOD,
          now,
          now,
          tenantId
        ]
      );
    } else if (workOrder.status === 'draft') {
      await client.query(
        `UPDATE work_orders
            SET status = 'in_progress',
                wip_total_cost = COALESCE(wip_total_cost, 0) + $2,
                wip_quantity_canonical = COALESCE(wip_quantity_canonical, 0) + $3,
                wip_unit_cost = CASE
                  WHEN (COALESCE(wip_quantity_canonical, 0) + $3) > 0
                  THEN (COALESCE(wip_total_cost, 0) + $2) / (COALESCE(wip_quantity_canonical, 0) + $3)
                  ELSE NULL
                END,
                wip_cost_method = $4,
                wip_costed_at = $5,
                updated_at = $6
          WHERE id = $1 AND tenant_id = $7`,
        [
          workOrderId,
          totalIssueCost,
          totalProducedCanonical,
          WIP_COST_METHOD,
          now,
          now,
          tenantId
        ]
      );
    } else {
      await client.query(
        `UPDATE work_orders
            SET wip_total_cost = COALESCE(wip_total_cost, 0) + $2,
                wip_quantity_canonical = COALESCE(wip_quantity_canonical, 0) + $3,
                wip_unit_cost = CASE
                  WHEN (COALESCE(wip_quantity_canonical, 0) + $3) > 0
                  THEN (COALESCE(wip_total_cost, 0) + $2) / (COALESCE(wip_quantity_canonical, 0) + $3)
                  ELSE NULL
                END,
                wip_cost_method = $4,
                wip_costed_at = $5,
                updated_at = $6
          WHERE id = $1 AND tenant_id = $7`,
        [
          workOrderId,
          totalIssueCost,
          totalProducedCanonical,
          WIP_COST_METHOD,
          now,
          now,
          tenantId
        ]
      );
    }

    const posted = await fetchWorkOrderCompletion(tenantId, workOrderId, completionId, client);
    if (!posted) {
      throw new Error('WO_COMPLETION_NOT_FOUND_AFTER_POST');
    }
    return posted;
  });
}

export async function getWorkOrderExecutionSummary(tenantId: string, workOrderId: string) {
  const workOrderResult = await query<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2', [
    workOrderId,
    tenantId
  ]);
  if (workOrderResult.rowCount === 0) {
    return null;
  }
  const workOrder = workOrderResult.rows[0];

  const issuedRows = await query(
    `SELECT l.component_item_id,
            i.sku AS component_item_sku,
            i.name AS component_item_name,
            l.uom,
            SUM(l.quantity_issued) AS qty
       FROM work_order_material_issue_lines l
       JOIN work_order_material_issues h ON h.id = l.work_order_material_issue_id
       JOIN items i ON i.id = l.component_item_id AND i.tenant_id = h.tenant_id
      WHERE h.work_order_id = $1
        AND h.status = 'posted'
        AND h.tenant_id = $2
        AND l.tenant_id = $2
      GROUP BY l.component_item_id, i.sku, i.name, l.uom`,
    [workOrderId, tenantId]
  );

  const producedRows = await query(
    `SELECT l.item_id,
            i.sku AS item_sku,
            i.name AS item_name,
            l.uom,
            SUM(l.quantity) AS qty
       FROM work_order_execution_lines l
       JOIN work_order_executions h ON h.id = l.work_order_execution_id
       JOIN items i ON i.id = l.item_id AND i.tenant_id = h.tenant_id
      WHERE h.work_order_id = $1
        AND h.status = 'posted'
        AND l.line_type = 'produce'
        AND h.tenant_id = $2
        AND l.tenant_id = $2
      GROUP BY l.item_id, i.sku, i.name, l.uom`,
    [workOrderId, tenantId]
  );

  const planned = roundQuantity(toNumber(workOrder.quantity_planned));
  const completed = roundQuantity(toNumber(workOrder.quantity_completed ?? 0));

  const bom = workOrder.bom_id ? await fetchBomById(tenantId, workOrder.bom_id) : null;

  return {
    workOrder: {
      id: workOrder.id,
      status: workOrder.status,
      kind: workOrder.kind,
      bomId: workOrder.bom_id,
      bomVersionId: workOrder.bom_version_id,
      outputItemId: workOrder.output_item_id,
      outputUom: workOrder.output_uom,
      quantityPlanned: planned,
      quantityCompleted: completed,
      completedAt: workOrder.completed_at
    },
    issuedTotals: issuedRows.rows.map((row: any) => ({
      componentItemId: row.component_item_id,
      componentItemSku: row.component_item_sku,
      componentItemName: row.component_item_name,
      uom: row.uom,
      quantityIssued: roundQuantity(toNumber(row.qty))
    })),
    completedTotals: producedRows.rows.map((row: any) => ({
      outputItemId: row.item_id,
      outputItemSku: row.item_sku,
      outputItemName: row.item_name,
      uom: row.uom,
      quantityCompleted: roundQuantity(toNumber(row.qty))
    })),
    remainingToComplete: roundQuantity(Math.max(0, planned - completed)),
    bom
  };
}

export async function recordWorkOrderBatch(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderBatchInput,
  context: NegativeOverrideContext = {}
) {
  const normalizedConsumes = data.consumeLines.map((line) => {
    const quantity = toNumber(line.quantity);
    if (quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_CONSUME_QTY');
    }
    return { ...line, quantity, uom: line.uom, reasonCode: line.reasonCode ?? null };
  });
  const normalizedProduces = data.produceLines.map((line) => {
    const quantity = toNumber(line.quantity);
    if (quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_PRODUCE_QTY');
    }
    return { ...line, quantity, uom: line.uom, reasonCode: line.reasonCode ?? null };
  });

  return withTransaction(async (client) => {
    const workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    const isDisassembly = workOrder.kind === 'disassembly';
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }
    if (!isDisassembly) {
      for (const line of normalizedProduces) {
        if (line.outputItemId !== workOrder.output_item_id) {
          throw new Error('WO_BATCH_ITEM_MISMATCH');
        }
      }
    } else {
      for (const line of normalizedConsumes) {
        if (line.componentItemId !== workOrder.output_item_id) {
          throw new Error('WO_DISASSEMBLY_INPUT_MISMATCH');
        }
      }
    }

    // Pre-validate items and locations to avoid foreign key failures
    const itemIds = Array.from(
      new Set([
        ...normalizedConsumes.map((l) => l.componentItemId),
        ...normalizedProduces.map((l) => l.outputItemId)
      ])
    );
    const locationIds = Array.from(
      new Set([
        ...normalizedConsumes.map((l) => l.fromLocationId),
        ...normalizedProduces.map((l) => l.toLocationId)
      ])
    );

    if (itemIds.length > 0) {
      const itemRes = await client.query<{ id: string }>(
        'SELECT id FROM items WHERE id = ANY($1) AND tenant_id = $2',
        [itemIds, tenantId]
      );
      const found = new Set(itemRes.rows.map((r) => r.id));
      const missingItems = itemIds.filter((id) => !found.has(id));
      if (missingItems.length > 0) {
        throw new Error(`WO_BATCH_ITEMS_MISSING:${missingItems.join(',')}`);
      }
    }

    if (locationIds.length > 0) {
      const locRes = await client.query<{ id: string }>(
        'SELECT id FROM locations WHERE id = ANY($1) AND tenant_id = $2',
        [locationIds, tenantId]
      );
      const found = new Set(locRes.rows.map((r) => r.id));
      const missingLocs = locationIds.filter((id) => !found.has(id));
      if (missingLocs.length > 0) {
        throw new Error(`WO_BATCH_LOCATIONS_MISSING:${missingLocs.join(',')}`);
      }
    }

    const issueId = uuidv4();
    const executionId = uuidv4();
    const issueMovementId = uuidv4();
    const receiveMovementId = uuidv4();
    const now = new Date();
    const occurredAt = new Date(data.occurredAt);
    const workOrderNumber = workOrder.number ?? workOrder.work_order_number;
    const validation = await validateSufficientStock(
      tenantId,
      occurredAt,
      normalizedConsumes.map((line) => ({
        itemId: line.componentItemId,
        locationId: line.fromLocationId,
        uom: line.uom,
        quantityToConsume: roundQuantity(line.quantity)
      })),
      {
        actorId: context.actor?.id ?? null,
        actorRole: context.actor?.role ?? null,
        overrideRequested: context.overrideRequested,
        overrideReason: context.overrideReason ?? null
      }
    );

    // Create movements first to satisfy FKs
    await client.query(
      `INSERT INTO inventory_movements (
          id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, metadata, created_at, updated_at
       ) VALUES ($1, $2, 'issue', 'posted', $3, $4, $5, $6, $7, $5, $5)`,
      [
        issueMovementId,
        tenantId,
        isDisassembly
          ? `work_order_disassembly_issue:${issueId}:${workOrderId}`
          : `work_order_batch_issue:${issueId}:${workOrderId}`,
        occurredAt,
        now,
        data.notes ?? null,
        {
          workOrderId,
          workOrderNumber,
          ...(validation.overrideMetadata ?? {})
        }
      ]
    );
    await client.query(
      `INSERT INTO inventory_movements (
          id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, metadata, created_at, updated_at
       ) VALUES ($1, $2, 'receive', 'posted', $3, $4, $5, $6, $7, $5, $5)`,
      [
        receiveMovementId,
        tenantId,
        isDisassembly
          ? `work_order_disassembly_completion:${executionId}:${workOrderId}`
          : `work_order_batch_completion:${executionId}:${workOrderId}`,
        occurredAt,
        now,
        data.notes ?? null,
        { workOrderId, workOrderNumber }
      ]
    );

    // Material issue header + lines
    await client.query(
      `INSERT INTO work_order_material_issues (
          id, tenant_id, work_order_id, status, occurred_at, inventory_movement_id, notes, created_at, updated_at
       ) VALUES ($1, $2, $3, 'posted', $4, $5, $6, $7, $7)`,
      [issueId, tenantId, workOrderId, occurredAt, issueMovementId, data.notes ?? null, now]
    );
    for (let i = 0; i < normalizedConsumes.length; i++) {
      const line = normalizedConsumes[i];
      await client.query(
        `INSERT INTO work_order_material_issue_lines (
            id, tenant_id, work_order_material_issue_id, line_number, component_item_id, uom, quantity_issued, from_location_id, reason_code, notes, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          uuidv4(),
          tenantId,
          issueId,
          i + 1,
          line.componentItemId,
          line.uom,
          line.quantity,
          line.fromLocationId,
          line.reasonCode,
          line.notes ?? null,
          now
        ]
      );
    }
    for (const line of normalizedConsumes) {
      const reasonCode = line.reasonCode ?? (isDisassembly ? 'disassembly_issue' : 'work_order_issue');
      
      const canonicalFields = await getCanonicalMovementFields(
        tenantId,
        line.componentItemId,
        -line.quantity,
        line.uom,
        client
      );
      
      // Consume from cost layers for backflush material consumption
      let issueCost = null as number | null;
      try {
        const consumption = await consumeCostLayers({
          tenant_id: tenantId,
          item_id: line.componentItemId,
          location_id: line.fromLocationId,
          quantity: line.quantity,
          consumption_type: 'production_input',
          consumption_document_id: issueId,
          movement_id: issueMovementId,
          client
        });
        issueCost = consumption.total_cost;
      } catch {
        throw new Error('WO_WIP_COST_LAYERS_MISSING');
      }
      const unitCost = issueCost !== null && line.quantity !== 0 ? issueCost / line.quantity : null;
      const extendedCost = issueCost !== null ? -issueCost : null;
      
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom,
            quantity_delta_entered, uom_entered, quantity_delta_canonical, canonical_uom, uom_dimension,
            unit_cost, extended_cost, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          uuidv4(),
          tenantId,
          issueMovementId,
          line.componentItemId,
          line.fromLocationId,
          -line.quantity,
          line.uom,
          canonicalFields.quantityDeltaEntered,
          canonicalFields.uomEntered,
          canonicalFields.quantityDeltaCanonical,
          canonicalFields.canonicalUom,
          canonicalFields.uomDimension,
          unitCost,
          extendedCost,
          reasonCode,
          line.notes ?? null
        ]
      );
    }

    // Execution header + produce lines
    await client.query(
      `INSERT INTO work_order_executions (
          id, tenant_id, work_order_id, occurred_at, status, consumption_movement_id, production_movement_id, notes, created_at
       ) VALUES ($1, $2, $3, $4, 'posted', $5, $6, $7, $8)`,
      [executionId, tenantId, workOrderId, occurredAt, issueMovementId, receiveMovementId, data.notes ?? null, now]
    );
    for (let i = 0; i < normalizedProduces.length; i++) {
      const line = normalizedProduces[i];
      await client.query(
        `INSERT INTO work_order_execution_lines (
            id, tenant_id, work_order_execution_id, line_type, item_id, uom, quantity, pack_size, from_location_id, to_location_id, reason_code, notes, created_at
         ) VALUES ($1, $2, $3, 'produce', $4, $5, $6, $7, NULL, $8, $9, $10, $11)`,
        [
          uuidv4(),
          tenantId,
          executionId,
          line.outputItemId,
          line.uom,
          line.quantity,
          line.packSize ?? null,
          line.toLocationId,
          line.reasonCode,
          line.notes ?? null,
          now
        ]
      );
    }
    const preparedProduces: Array<{
      line: (typeof normalizedProduces)[number];
      canonicalFields: CanonicalMovementFields;
    }> = [];
    let producedTotal = 0;
    let producedCanonicalTotal = 0;

    for (const line of normalizedProduces) {
      const canonicalFields = await getCanonicalMovementFields(
        tenantId,
        line.outputItemId,
        line.quantity,
        line.uom,
        client
      );
      producedTotal += line.quantity;
      producedCanonicalTotal += canonicalFields.quantityDeltaCanonical;
      preparedProduces.push({ line, canonicalFields });
    }

    if (producedCanonicalTotal <= 0) {
      throw new Error('WO_WIP_COST_INVALID_OUTPUT_QTY');
    }

    const totalIssueCost = await allocateWipCostFromMovement(
      client,
      tenantId,
      executionId,
      issueMovementId,
      now
    );
    const wipUnitCostCanonical = totalIssueCost / producedCanonicalTotal;

    for (const { line, canonicalFields } of preparedProduces) {
      const reasonCode = line.reasonCode ?? (isDisassembly ? 'disassembly_completion' : 'work_order_completion');
      const allocationRatio = canonicalFields.quantityDeltaCanonical / producedCanonicalTotal;
      const allocatedCost = totalIssueCost * allocationRatio;
      const unitCost = line.quantity !== 0 ? allocatedCost / line.quantity : null;
      const extendedCost = allocatedCost;

      // Create cost layer for backflush production output
      await createCostLayer({
        tenant_id: tenantId,
        item_id: line.outputItemId,
        location_id: line.toLocationId,
        uom: line.uom,
        quantity: line.quantity,
        unit_cost: unitCost ?? 0,
        source_type: 'production',
        source_document_id: issueId,
        movement_id: receiveMovementId,
        notes: `Backflush production from work order ${workOrderId}`,
        client
      });

      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom,
            quantity_delta_entered, uom_entered, quantity_delta_canonical, canonical_uom, uom_dimension,
            unit_cost, extended_cost, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          uuidv4(),
          tenantId,
          receiveMovementId,
          line.outputItemId,
          line.toLocationId,
          line.quantity,
          line.uom,
          canonicalFields.quantityDeltaEntered,
          canonicalFields.uomEntered,
          canonicalFields.quantityDeltaCanonical,
          canonicalFields.canonicalUom,
          canonicalFields.uomDimension,
          unitCost,
          extendedCost,
          reasonCode,
          line.notes ?? null
        ]
      );
    }

    await client.query(
      `UPDATE work_order_executions
          SET wip_total_cost = $1,
              wip_unit_cost = $2,
              wip_quantity_canonical = $3,
              wip_cost_method = $4,
              wip_costed_at = $5
        WHERE id = $6 AND tenant_id = $7`,
      [
        totalIssueCost,
        wipUnitCostCanonical,
        producedCanonicalTotal,
        WIP_COST_METHOD,
        now,
        executionId,
        tenantId
      ]
    );

    // Update work order progress
    const consumedTotal = normalizedConsumes.reduce((sum, line) => sum + line.quantity, 0);
    const currentCompleted = toNumber(workOrder.quantity_completed ?? 0);
    const progressQty = isDisassembly ? consumedTotal : producedTotal;
    const newCompleted = currentCompleted + progressQty;
    const planned = toNumber(workOrder.quantity_planned);
    const completedAt = newCompleted >= planned ? now : null;
    const newStatus = newCompleted >= planned ? 'completed' : workOrder.status === 'draft' ? 'in_progress' : workOrder.status;

    await client.query(
      `UPDATE work_orders
          SET quantity_completed = $2,
              status = $3,
              completed_at = COALESCE(completed_at, $4),
              wip_total_cost = COALESCE(wip_total_cost, 0) + $5,
              wip_quantity_canonical = COALESCE(wip_quantity_canonical, 0) + $6,
              wip_unit_cost = CASE
                WHEN (COALESCE(wip_quantity_canonical, 0) + $6) > 0
                THEN (COALESCE(wip_total_cost, 0) + $5) / (COALESCE(wip_quantity_canonical, 0) + $6)
                ELSE NULL
              END,
              wip_cost_method = $7,
              wip_costed_at = $8,
              updated_at = $9
        WHERE id = $1 AND tenant_id = $10`,
      [
        workOrderId,
        newCompleted,
        newStatus,
        completedAt,
        totalIssueCost,
        producedCanonicalTotal,
        WIP_COST_METHOD,
        now,
        now,
        tenantId
      ]
    );

    if (validation.overrideMetadata && context.actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: context.actor.type,
          actorId: context.actor.id ?? null,
          action: 'negative_override',
          entityType: 'inventory_movement',
          entityId: issueMovementId,
          occurredAt: now,
          metadata: {
            reason: validation.overrideMetadata.override_reason ?? null,
            workOrderId,
            executionId,
            lines: normalizedConsumes.map((line) => ({
              itemId: line.componentItemId,
              locationId: line.fromLocationId,
              uom: line.uom,
              quantity: roundQuantity(line.quantity)
            }))
          }
        },
        client
      );
    }

    return {
      workOrderId,
      issueMovementId,
      receiveMovementId,
      quantityCompleted: newCompleted,
      workOrderStatus: newStatus
    };
  });
}
