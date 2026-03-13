import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { releaseWorkOrderReservations } from './inventoryReservation.service';

type WorkOrderRow = {
  id: string;
  status: string;
  kind: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
  quantity_scrapped: string | number | null;
  completed_at: string | null;
};

function structuredError(code: string, details?: Record<string, unknown>) {
  const error = new Error(code) as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = code;
  error.details = details;
  return error;
}

async function loadWorkOrder(
  tenantId: string,
  workOrderId: string,
  client?: PoolClient
): Promise<WorkOrderRow | null> {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor<WorkOrderRow>(
    `SELECT id, status, kind, quantity_planned, quantity_completed, quantity_scrapped, completed_at
       FROM work_orders
      WHERE tenant_id = $1
        AND id = $2
      FOR UPDATE`,
    [tenantId, workOrderId]
  );
  return result.rows[0] ?? null;
}

export async function closeWorkOrder(
  tenantId: string,
  workOrderId: string,
  actor?: { type: 'user' | 'system'; id?: string | null }
) {
  return withTransaction(async (client) => {
    const workOrder = await loadWorkOrder(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }

    const openDrafts = await client.query<{ issue_count: string | number; execution_count: string | number }>(
      `SELECT
          (SELECT COUNT(*)::numeric
             FROM work_order_material_issues
            WHERE tenant_id = $1
              AND work_order_id = $2
              AND status = 'draft') AS issue_count,
          (SELECT COUNT(*)::numeric
             FROM work_order_executions
            WHERE tenant_id = $1
              AND work_order_id = $2
              AND status = 'draft') AS execution_count`,
      [tenantId, workOrderId]
    );
    const issueCount = roundQuantity(toNumber(openDrafts.rows[0]?.issue_count ?? 0));
    const executionCount = roundQuantity(toNumber(openDrafts.rows[0]?.execution_count ?? 0));
    if (issueCount > 0 || executionCount > 0) {
      throw structuredError('WO_CLOSE_DRAFT_POSTINGS_EXIST', {
        workOrderId,
        draftIssues: issueCount,
        draftExecutions: executionCount
      });
    }

    const planned = roundQuantity(toNumber(workOrder.quantity_planned));
    const completed = roundQuantity(toNumber(workOrder.quantity_completed ?? 0));
    const scrapped = roundQuantity(toNumber(workOrder.quantity_scrapped ?? 0));
    if (completed + scrapped + 1e-6 < planned) {
      throw structuredError('WO_CLOSE_INCOMPLETE_PROGRESS', {
        workOrderId,
        planned,
        completed,
        scrapped,
        remaining: roundQuantity(Math.max(0, planned - completed - scrapped))
      });
    }

    const { getWorkOrderExecutionSummary, verifyWorkOrderWipIntegrityForClose } = await import('./workOrderExecution.service');
    await verifyWorkOrderWipIntegrityForClose(tenantId, workOrderId, client);
    const executionSummary = await getWorkOrderExecutionSummary(tenantId, workOrderId);
    const { getWorkOrderRequirements } = await import('./workOrders.service');
    const expectedRequirements = workOrder.kind === 'production'
      ? await getWorkOrderRequirements(tenantId, workOrderId, planned)
      : null;

    const expectedByComponent = new Map<string, number>();
    for (const line of expectedRequirements?.lines ?? []) {
      const key = `${line.componentItemId}:${line.uom}`;
      expectedByComponent.set(key, roundQuantity((expectedByComponent.get(key) ?? 0) + line.quantityRequired));
    }
    const issuedVariance = (executionSummary?.issuedTotals ?? []).map((line) => {
      const key = `${line.componentItemId}:${line.uom}`;
      const expectedQty = roundQuantity(expectedByComponent.get(key) ?? 0);
      const actualQty = roundQuantity(line.quantityIssued);
      return {
        componentItemId: line.componentItemId,
        uom: line.uom,
        expectedQty,
        actualQty,
        varianceQty: roundQuantity(actualQty - expectedQty)
      };
    });

    await releaseWorkOrderReservations(tenantId, workOrderId, 'work_order_closed', client);

    const now = new Date();
    await client.query(
      `UPDATE work_orders
          SET status = 'closed',
              completed_at = COALESCE(completed_at, $1),
              updated_at = $1
        WHERE tenant_id = $2
          AND id = $3`,
      [now, tenantId, workOrderId]
    );

    await recordAuditLog(
      {
        tenantId,
        actorType: actor?.type ?? 'system',
        actorId: actor?.id ?? null,
        action: 'work_order_close',
        entityType: 'work_order',
        entityId: workOrderId,
        occurredAt: now,
        metadata: {
          planned,
          completed,
          scrapped,
          issuedVariance
        }
      },
      client
    );

    const updated = await loadWorkOrder(tenantId, workOrderId, client);
    return {
      ...(updated ?? workOrder),
      closeSummary: {
        planned,
        completed,
        scrapped,
        issuedVariance
      }
    };
  });
}
