import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { fetchBomById } from './boms.service';
import {
  workOrderCompletionCreateSchema,
  workOrderIssueCreateSchema,
  workOrderBatchSchema
} from '../schemas/workOrderExecution.schema';
import { normalizeQuantityByUom } from '../lib/uom';

type WorkOrderIssueCreateInput = z.infer<typeof workOrderIssueCreateSchema>;
type WorkOrderCompletionCreateInput = z.infer<typeof workOrderCompletionCreateSchema>;
type WorkOrderBatchInput = z.infer<typeof workOrderBatchSchema>;

type WorkOrderRow = {
  id: string;
  status: string;
  bom_id: string;
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
  from_location_id: string | null;
  to_location_id: string | null;
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
    notes: row.notes,
    createdAt: row.created_at,
    lines: lines.map((line) => ({
      id: line.id,
      lineType: line.line_type,
      itemId: line.item_id,
      uom: line.uom,
      quantity: roundQuantity(toNumber(line.quantity)),
      fromLocationId: line.from_location_id,
      toLocationId: line.to_location_id,
      notes: line.notes,
      createdAt: line.created_at
    }))
  };
}

async function fetchWorkOrderById(id: string, client?: PoolClient): Promise<WorkOrderRow | null> {
  const executor = client ?? query;
  const result = await executor<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1', [id]);
  return result.rowCount === 0 ? null : result.rows[0];
}

export async function createWorkOrderIssue(workOrderId: string, data: WorkOrderIssueCreateInput) {
  const lineNumbers = new Set<number>();
  const normalizedLines = data.lines.map((line, index) => {
    const lineNumber = line.lineNumber ?? index + 1;
    if (lineNumbers.has(lineNumber)) {
      throw new Error('WO_ISSUE_DUPLICATE_LINE');
    }
    const normalized = normalizeQuantityByUom(line.quantityIssued, line.uom);
    lineNumbers.add(lineNumber);
    return {
      lineNumber,
      componentItemId: line.componentItemId,
      fromLocationId: line.fromLocationId,
      uom: normalized.uom,
      quantityIssued: normalized.quantity,
      notes: line.notes ?? null
    };
  });

  const issueId = uuidv4();
  const now = new Date();

  return withTransaction(async (client) => {
    const workOrder = await fetchWorkOrderById(workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }

    await client.query(
      `INSERT INTO work_order_material_issues (
          id, work_order_id, status, occurred_at, inventory_movement_id, notes, created_at, updated_at
       ) VALUES ($1, $2, 'draft', $3, NULL, $4, $5, $5)`,
      [issueId, workOrderId, new Date(data.occurredAt), data.notes ?? null, now]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO work_order_material_issue_lines (
            id, work_order_material_issue_id, line_number, component_item_id, uom, quantity_issued, from_location_id, notes, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          uuidv4(),
          issueId,
          line.lineNumber,
          line.componentItemId,
          line.uom,
          line.quantityIssued,
          line.fromLocationId,
          line.notes,
          now
        ]
      );
    }

    const issue = await fetchWorkOrderIssue(workOrderId, issueId, client);
    if (!issue) {
      throw new Error('WO_ISSUE_NOT_FOUND_AFTER_CREATE');
    }
    return issue;
  });
}

export async function fetchWorkOrderIssue(workOrderId: string, issueId: string, client?: PoolClient) {
  const executor = client ?? query;
  const headerResult = await executor<WorkOrderMaterialIssueRow>(
    'SELECT * FROM work_order_material_issues WHERE id = $1 AND work_order_id = $2',
    [issueId, workOrderId]
  );
  if (headerResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor<WorkOrderMaterialIssueLineRow>(
    'SELECT * FROM work_order_material_issue_lines WHERE work_order_material_issue_id = $1 ORDER BY line_number ASC',
    [issueId]
  );
  return mapMaterialIssue(headerResult.rows[0], linesResult.rows);
}

export async function postWorkOrderIssue(workOrderId: string, issueId: string) {
  return withTransaction(async (client) => {
    const workOrder = await fetchWorkOrderById(workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }

    const issueResult = await client.query<WorkOrderMaterialIssueRow>(
      'SELECT * FROM work_order_material_issues WHERE id = $1 AND work_order_id = $2 FOR UPDATE',
      [issueId, workOrderId]
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
      'SELECT * FROM work_order_material_issue_lines WHERE work_order_material_issue_id = $1 ORDER BY line_number ASC',
      [issueId]
    );
    if (linesResult.rowCount === 0) {
      throw new Error('WO_ISSUE_NO_LINES');
    }

    const now = new Date();
    const movementId = uuidv4();
    await client.query(
      `INSERT INTO inventory_movements (
          id, movement_type, status, external_ref, occurred_at, posted_at, notes, created_at, updated_at
       ) VALUES ($1, 'issue', 'posted', $2, $3, $4, $5, $4, $4)`,
      [movementId, `work_order_issue:${issueId}`, issue.occurred_at, now, issue.notes ?? null]
    );

    for (const line of linesResult.rows) {
      const normalized = normalizeQuantityByUom(roundQuantity(toNumber(line.quantity_issued)), line.uom);
      const qty = normalized.quantity;
      if (qty <= 0) {
        throw new Error('WO_ISSUE_INVALID_QUANTITY');
      }
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, 'work_order_issue', $7)`,
        [
          uuidv4(),
          movementId,
          line.component_item_id,
          line.from_location_id,
          roundQuantity(-qty),
          normalized.uom,
          line.notes ?? `Work order issue ${issueId} line ${line.line_number}`
        ]
      );
    }

    await client.query(
      `UPDATE work_order_material_issues
          SET status = 'posted',
              inventory_movement_id = $1,
              updated_at = $2
        WHERE id = $3`,
      [movementId, now, issueId]
    );

    if (workOrder.status === 'draft') {
      await client.query(`UPDATE work_orders SET status = 'in_progress', updated_at = $2 WHERE id = $1`, [workOrderId, now]);
    }

    const posted = await fetchWorkOrderIssue(workOrderId, issueId, client);
    if (!posted) {
      throw new Error('WO_ISSUE_NOT_FOUND_AFTER_POST');
    }
    return posted;
  });
}

export async function createWorkOrderCompletion(workOrderId: string, data: WorkOrderCompletionCreateInput) {
  const executionId = uuidv4();
  const now = new Date();
  const normalizedLines = data.lines.map((line) => {
    const normalized = normalizeQuantityByUom(line.quantityCompleted, line.uom);
    return { ...line, uom: normalized.uom, quantityCompleted: normalized.quantity };
  });

  return withTransaction(async (client) => {
    const workOrder = await fetchWorkOrderById(workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }

    await client.query(
      `INSERT INTO work_order_executions (
          id, work_order_id, occurred_at, status, consumption_movement_id, production_movement_id, notes, created_at
       ) VALUES ($1, $2, $3, 'draft', NULL, NULL, $4, $5)`,
      [executionId, workOrderId, new Date(data.occurredAt), data.notes ?? null, now]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO work_order_execution_lines (
            id, work_order_execution_id, line_type, item_id, uom, quantity, from_location_id, to_location_id, notes, created_at
         ) VALUES ($1, $2, 'produce', $3, $4, $5, NULL, $6, $7, $8)`,
        [
          uuidv4(),
          executionId,
          line.outputItemId,
          line.uom,
          roundQuantity(line.quantityCompleted),
          line.toLocationId,
          line.notes ?? null,
          now
        ]
      );
    }

    const created = await fetchWorkOrderCompletion(workOrderId, executionId, client);
    if (!created) {
      throw new Error('WO_COMPLETION_NOT_FOUND_AFTER_CREATE');
    }
    return created;
  });
}

export async function fetchWorkOrderCompletion(workOrderId: string, completionId: string, client?: PoolClient) {
  const executor = client ?? query;
  const headerResult = await executor<WorkOrderExecutionRow>(
    'SELECT * FROM work_order_executions WHERE id = $1 AND work_order_id = $2',
    [completionId, workOrderId]
  );
  if (headerResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor<WorkOrderExecutionLineRow>(
    'SELECT * FROM work_order_execution_lines WHERE work_order_execution_id = $1 ORDER BY created_at ASC',
    [completionId]
  );
  return mapExecution(headerResult.rows[0], linesResult.rows);
}

export async function postWorkOrderCompletion(workOrderId: string, completionId: string) {
  return withTransaction(async (client) => {
    const workOrder = await fetchWorkOrderById(workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }

    const execResult = await client.query<WorkOrderExecutionRow>(
      'SELECT * FROM work_order_executions WHERE id = $1 AND work_order_id = $2 FOR UPDATE',
      [completionId, workOrderId]
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
      'SELECT * FROM work_order_execution_lines WHERE work_order_execution_id = $1 ORDER BY created_at ASC',
      [completionId]
    );
    if (linesResult.rowCount === 0) {
      throw new Error('WO_COMPLETION_NO_LINES');
    }

    const totalProduced = linesResult.rows.reduce((sum, line) => sum + roundQuantity(toNumber(line.quantity)), 0);
    const producedRounded = roundQuantity(totalProduced);

    for (const line of linesResult.rows) {
      if (line.line_type !== 'produce') {
        throw new Error('WO_COMPLETION_INVALID_LINE_TYPE');
      }
      if (line.item_id !== workOrder.output_item_id) {
        throw new Error('WO_COMPLETION_ITEM_MISMATCH');
      }
      if (!line.to_location_id) {
        throw new Error('WO_COMPLETION_LOCATION_REQUIRED');
      }
      const normalized = normalizeQuantityByUom(roundQuantity(toNumber(line.quantity)), line.uom);
      const qty = normalized.quantity;
      if (qty <= 0) {
        throw new Error('WO_COMPLETION_INVALID_QUANTITY');
      }
    }

    const now = new Date();
    const movementId = uuidv4();
    await client.query(
      `INSERT INTO inventory_movements (
          id, movement_type, status, external_ref, occurred_at, posted_at, notes, created_at, updated_at
       ) VALUES ($1, 'receive', 'posted', $2, $3, $4, $5, $4, $4)`,
      [movementId, `work_order_completion:${completionId}`, execution.occurred_at, now, execution.notes ?? null]
    );

    for (const line of linesResult.rows) {
      const normalized = normalizeQuantityByUom(roundQuantity(toNumber(line.quantity)), line.uom);
      const qty = normalized.quantity;
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, 'work_order_completion', $7)`,
        [
          uuidv4(),
          movementId,
          line.item_id,
          line.to_location_id,
          qty,
          normalized.uom,
          line.notes ?? `Work order completion ${completionId}`
        ]
      );
    }

    await client.query(
      `UPDATE work_order_executions
          SET status = 'posted',
              production_movement_id = $1
        WHERE id = $2`,
      [movementId, completionId]
    );

    const currentCompleted = roundQuantity(toNumber(workOrder.quantity_completed ?? 0));
    const newCompleted = roundQuantity(currentCompleted + producedRounded);
    const planned = roundQuantity(toNumber(workOrder.quantity_planned));
    const completedAt = newCompleted >= planned ? now : null;
    const newStatus = newCompleted >= planned ? 'completed' : workOrder.status === 'draft' ? 'in_progress' : workOrder.status;

    await client.query(
      `UPDATE work_orders
          SET quantity_completed = $2,
              status = $3,
              completed_at = COALESCE(completed_at, $4),
              updated_at = $5
        WHERE id = $1`,
      [workOrderId, newCompleted, newStatus, completedAt, now]
    );

    const posted = await fetchWorkOrderCompletion(workOrderId, completionId, client);
    if (!posted) {
      throw new Error('WO_COMPLETION_NOT_FOUND_AFTER_POST');
    }
    return posted;
  });
}

export async function getWorkOrderExecutionSummary(workOrderId: string) {
  const workOrderResult = await query<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1', [workOrderId]);
  if (workOrderResult.rowCount === 0) {
    return null;
  }
  const workOrder = workOrderResult.rows[0];

  const issuedRows = await query(
    `SELECT l.component_item_id, l.uom, SUM(l.quantity_issued) AS qty
       FROM work_order_material_issue_lines l
       JOIN work_order_material_issues h ON h.id = l.work_order_material_issue_id
      WHERE h.work_order_id = $1
        AND h.status = 'posted'
      GROUP BY l.component_item_id, l.uom`,
    [workOrderId]
  );

  const producedRows = await query(
    `SELECT l.item_id, l.uom, SUM(l.quantity) AS qty
       FROM work_order_execution_lines l
       JOIN work_order_executions h ON h.id = l.work_order_execution_id
      WHERE h.work_order_id = $1
        AND h.status = 'posted'
        AND l.line_type = 'produce'
      GROUP BY l.item_id, l.uom`,
    [workOrderId]
  );

  const planned = roundQuantity(toNumber(workOrder.quantity_planned));
  const completed = roundQuantity(toNumber(workOrder.quantity_completed ?? 0));

  const bom = await fetchBomById(workOrder.bom_id);

  return {
    workOrder: {
      id: workOrder.id,
      status: workOrder.status,
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
      uom: row.uom,
      quantityIssued: roundQuantity(toNumber(row.qty))
    })),
    completedTotals: producedRows.rows.map((row: any) => ({
      outputItemId: row.item_id,
      uom: row.uom,
      quantityCompleted: roundQuantity(toNumber(row.qty))
    })),
    remainingToComplete: roundQuantity(Math.max(0, planned - completed)),
    bom
  };
}

export async function recordWorkOrderBatch(workOrderId: string, data: WorkOrderBatchInput) {
  const normalizedConsumes = data.consumeLines.map((line) => {
    const normalized = normalizeQuantityByUom(line.quantity, line.uom);
    if (normalized.quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_CONSUME_QTY');
    }
    return { ...line, quantity: normalized.quantity, uom: normalized.uom };
  });
  const normalizedProduces = data.produceLines.map((line) => {
    const normalized = normalizeQuantityByUom(line.quantity, line.uom);
    if (normalized.quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_PRODUCE_QTY');
    }
    return { ...line, quantity: normalized.quantity, uom: normalized.uom };
  });

  return withTransaction(async (client) => {
    const workOrder = await fetchWorkOrderById(workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }
    for (const line of normalizedProduces) {
      if (line.outputItemId !== workOrder.output_item_id) {
        throw new Error('WO_BATCH_ITEM_MISMATCH');
      }
    }

    const issueId = uuidv4();
    const executionId = uuidv4();
    const issueMovementId = uuidv4();
    const receiveMovementId = uuidv4();
    const now = new Date();
    const occurredAt = new Date(data.occurredAt);

    // Material issue header + lines
    await client.query(
      `INSERT INTO work_order_material_issues (
          id, work_order_id, status, occurred_at, inventory_movement_id, notes, created_at, updated_at
       ) VALUES ($1, $2, 'posted', $3, $4, $5, $6, $6)`,
      [issueId, workOrderId, occurredAt, issueMovementId, data.notes ?? null, now]
    );
    for (let i = 0; i < normalizedConsumes.length; i++) {
      const line = normalizedConsumes[i];
      await client.query(
        `INSERT INTO work_order_material_issue_lines (
            id, work_order_material_issue_id, line_number, component_item_id, uom, quantity_issued, from_location_id, notes, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          uuidv4(),
          issueId,
          i + 1,
          line.componentItemId,
          line.uom,
          roundQuantity(line.quantity),
          line.fromLocationId,
          line.notes ?? null,
          now
        ]
      );
    }

    // Issue inventory movement
    await client.query(
      `INSERT INTO inventory_movements (
          id, movement_type, status, external_ref, occurred_at, posted_at, notes, created_at, updated_at
       ) VALUES ($1, 'issue', 'posted', $2, $3, $4, $5, $4, $4)`,
      [issueMovementId, `work_order_batch_issue:${issueId}`, occurredAt, now, data.notes ?? null]
    );
    for (const line of normalizedConsumes) {
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, 'work_order_issue', $7)`,
        [
          uuidv4(),
          issueMovementId,
          line.componentItemId,
          line.fromLocationId,
          roundQuantity(-line.quantity),
          line.uom,
          line.notes ?? null
        ]
      );
    }

    // Execution header + produce lines
    await client.query(
      `INSERT INTO work_order_executions (
          id, work_order_id, occurred_at, status, consumption_movement_id, production_movement_id, notes, created_at
       ) VALUES ($1, $2, $3, 'posted', $4, $5, $6, $7)`,
      [executionId, workOrderId, occurredAt, issueMovementId, receiveMovementId, data.notes ?? null, now]
    );
    for (let i = 0; i < normalizedProduces.length; i++) {
      const line = normalizedProduces[i];
      await client.query(
        `INSERT INTO work_order_execution_lines (
            id, work_order_execution_id, line_type, item_id, uom, quantity, from_location_id, to_location_id, notes, created_at
         ) VALUES ($1, $2, 'produce', $3, $4, $5, NULL, $6, $7, $8)`,
        [
          uuidv4(),
          executionId,
          line.outputItemId,
          line.uom,
          roundQuantity(line.quantity),
          line.toLocationId,
          line.notes ?? null,
          now
        ]
      );
    }

    // Receive inventory movement
    await client.query(
      `INSERT INTO inventory_movements (
          id, movement_type, status, external_ref, occurred_at, posted_at, notes, created_at, updated_at
       ) VALUES ($1, 'receive', 'posted', $2, $3, $4, $5, $4, $4)`,
      [receiveMovementId, `work_order_batch_completion:${executionId}`, occurredAt, now, data.notes ?? null]
    );
    for (const line of normalizedProduces) {
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, 'work_order_completion', $7)`,
        [
          uuidv4(),
          receiveMovementId,
          line.outputItemId,
          line.toLocationId,
          roundQuantity(line.quantity),
          line.uom,
          line.notes ?? null
        ]
      );
    }

    // Update work order progress
    const producedTotal = normalizedProduces.reduce((sum, line) => sum + roundQuantity(line.quantity), 0);
    const currentCompleted = roundQuantity(toNumber(workOrder.quantity_completed ?? 0));
    const newCompleted = roundQuantity(currentCompleted + producedTotal);
    const planned = roundQuantity(toNumber(workOrder.quantity_planned));
    const completedAt = newCompleted >= planned ? now : null;
    const newStatus = newCompleted >= planned ? 'completed' : workOrder.status === 'draft' ? 'in_progress' : workOrder.status;

    await client.query(
      `UPDATE work_orders
          SET quantity_completed = $2,
              status = $3,
              completed_at = COALESCE(completed_at, $4),
              updated_at = $5
        WHERE id = $1`,
      [workOrderId, newCompleted, newStatus, completedAt, now]
    );

    return {
      workOrderId,
      issueMovementId,
      receiveMovementId,
      quantityCompleted: newCompleted,
      workOrderStatus: newStatus
    };
  });
}
