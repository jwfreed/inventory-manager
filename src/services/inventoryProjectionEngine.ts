import { recordAuditLog } from '../lib/audit';
import { roundQuantity, toNumber } from '../lib/numbers';
import type { InventoryCommandProjectionOp } from '../modules/platform/application/runInventoryCommand';
import {
  nextStatusAfterExecutionStart,
  nextStatusFromProgress,
  normalizeWorkOrderStatus
} from './workOrderLifecycle.service';
import { WIP_COST_METHOD } from './wipAccountingEngine';
import type {
  NegativeOverrideContext,
  NormalizedBatchConsumeLine,
  WorkOrderMaterialIssueLineRow,
  WorkOrderRow
} from './workOrderExecution.types';

export function buildIssueProjectionOps(params: {
  tenantId: string;
  issueId: string;
  movementId: string;
  now: Date;
  workOrderId: string;
  workOrder: WorkOrderRow;
  isDisassembly: boolean;
  issuedTotal: number;
  validationOverrideMetadata?: Record<string, unknown> | null;
  context: NegativeOverrideContext;
  linesForPosting: WorkOrderMaterialIssueLineRow[];
}): InventoryCommandProjectionOp[] {
  const projectionOps: InventoryCommandProjectionOp[] = [];
  projectionOps.push(async (projectionClient) => {
    await projectionClient.query(
      `UPDATE work_order_material_issues
          SET status = 'posted',
              inventory_movement_id = $1,
              updated_at = $2
        WHERE id = $3
          AND tenant_id = $4`,
      [params.movementId, params.now, params.issueId, params.tenantId]
    );

    if (
      normalizeWorkOrderStatus(params.workOrder.status) === 'draft'
      || normalizeWorkOrderStatus(params.workOrder.status) === 'ready'
    ) {
      await projectionClient.query(
        `UPDATE work_orders
            SET status = $2,
                updated_at = $3
          WHERE id = $1
            AND tenant_id = $4`,
        [
          params.workOrderId,
          nextStatusAfterExecutionStart(params.workOrder.status),
          params.now,
          params.tenantId
        ]
      );
    }

    if (params.isDisassembly) {
      const currentCompleted = toNumber(params.workOrder.quantity_completed ?? 0);
      const newCompleted = currentCompleted + params.issuedTotal;
      const planned = toNumber(params.workOrder.quantity_planned);
      const completedAt = newCompleted >= planned ? params.now : null;
      const nextStatus = nextStatusFromProgress({
        currentStatus: params.workOrder.status,
        plannedQuantity: planned,
        completedQuantity: newCompleted
      });
      await projectionClient.query(
        `UPDATE work_orders
            SET quantity_completed = $2,
                status = $3,
                completed_at = COALESCE(completed_at, $4),
                updated_at = $5
          WHERE id = $1
            AND tenant_id = $6`,
        [params.workOrderId, newCompleted, nextStatus, completedAt, params.now, params.tenantId]
      );
    }

    if (params.validationOverrideMetadata && params.context.actor) {
      await recordAuditLog(
        {
          tenantId: params.tenantId,
          actorType: params.context.actor.type,
          actorId: params.context.actor.id ?? null,
          action: 'negative_override',
          entityType: 'inventory_movement',
          entityId: params.movementId,
          occurredAt: params.now,
          metadata: {
            reason: params.validationOverrideMetadata.override_reason ?? null,
            workOrderId: params.workOrderId,
            issueId: params.issueId,
            reference: params.validationOverrideMetadata.override_reference ?? null,
            lines: params.linesForPosting.map((line) => ({
              itemId: line.component_item_id,
              locationId: line.from_location_id,
              uom: line.uom,
              quantity: roundQuantity(toNumber(line.quantity_issued))
            }))
          }
        },
        projectionClient
      );
    }
  });
  return projectionOps;
}

export function buildCompletionProjectionOps(params: {
  tenantId: string;
  completionId: string;
  movementId: string;
  now: Date;
  workOrderId: string;
  workOrder: WorkOrderRow;
  isDisassembly: boolean;
  totalIssueCost: number;
  wipUnitCostCanonical: number;
  totalProducedCanonical: number;
  totalProduced: number;
}): InventoryCommandProjectionOp[] {
  const projectionOps: InventoryCommandProjectionOp[] = [];
  projectionOps.push(async (projectionClient) => {
    await projectionClient.query(
      `UPDATE work_order_executions
          SET status = 'posted',
              production_movement_id = $1,
              wip_total_cost = $2,
              wip_unit_cost = $3,
              wip_quantity_canonical = $4,
              wip_cost_method = $5,
              wip_costed_at = $6
        WHERE id = $7
          AND tenant_id = $8`,
      [
        params.movementId,
        params.totalIssueCost,
        params.wipUnitCostCanonical,
        params.totalProducedCanonical,
        WIP_COST_METHOD,
        params.now,
        params.completionId,
        params.tenantId
      ]
    );

    if (!params.isDisassembly) {
      const currentCompleted = toNumber(params.workOrder.quantity_completed ?? 0);
      const newCompleted = currentCompleted + params.totalProduced;
      const planned = toNumber(params.workOrder.quantity_planned);
      const completedAt = newCompleted >= planned ? params.now : null;
      const newStatus = nextStatusFromProgress({
        currentStatus: params.workOrder.status,
        plannedQuantity: planned,
        completedQuantity: newCompleted
      });
      await projectionClient.query(
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
          WHERE id = $1
            AND tenant_id = $10`,
        [
          params.workOrderId,
          newCompleted,
          newStatus,
          completedAt,
          params.totalIssueCost,
          params.totalProducedCanonical,
          WIP_COST_METHOD,
          params.now,
          params.now,
          params.tenantId
        ]
      );
      return;
    }

    if (
      normalizeWorkOrderStatus(params.workOrder.status) === 'draft'
      || normalizeWorkOrderStatus(params.workOrder.status) === 'ready'
    ) {
      await projectionClient.query(
        `UPDATE work_orders
            SET status = $2,
                wip_total_cost = COALESCE(wip_total_cost, 0) + $3,
                wip_quantity_canonical = COALESCE(wip_quantity_canonical, 0) + $4,
                wip_unit_cost = CASE
                  WHEN (COALESCE(wip_quantity_canonical, 0) + $4) > 0
                  THEN (COALESCE(wip_total_cost, 0) + $3) / (COALESCE(wip_quantity_canonical, 0) + $4)
                  ELSE NULL
                END,
                wip_cost_method = $5,
                wip_costed_at = $6,
                updated_at = $7
          WHERE id = $1
            AND tenant_id = $8`,
        [
          params.workOrderId,
          nextStatusAfterExecutionStart(params.workOrder.status),
          params.totalIssueCost,
          params.totalProducedCanonical,
          WIP_COST_METHOD,
          params.now,
          params.now,
          params.tenantId
        ]
      );
      return;
    }

    await projectionClient.query(
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
        WHERE id = $1
          AND tenant_id = $7`,
      [
        params.workOrderId,
        params.totalIssueCost,
        params.totalProducedCanonical,
        WIP_COST_METHOD,
        params.now,
        params.now,
        params.tenantId
      ]
    );
  });
  return projectionOps;
}

export function buildBatchProjectionOps(params: {
  tenantId: string;
  executionId: string;
  workOrderId: string;
  issueMovementId: string;
  now: Date;
  workOrder: WorkOrderRow;
  totalIssueCost: number;
  wipUnitCostCanonical: number;
  producedCanonicalTotal: number;
  newCompleted: number;
  newStatus: string;
  completedAt: Date | null;
  validationOverrideMetadata?: Record<string, unknown> | null;
  context: NegativeOverrideContext;
  consumeLinesOrdered: NormalizedBatchConsumeLine[];
}): InventoryCommandProjectionOp[] {
  const projectionOps: InventoryCommandProjectionOp[] = [];
  projectionOps.push(async (projectionClient) => {
    await projectionClient.query(
      `UPDATE work_order_executions
          SET wip_total_cost = $1,
              wip_unit_cost = $2,
              wip_quantity_canonical = $3,
              wip_cost_method = $4,
              wip_costed_at = $5
        WHERE id = $6
          AND tenant_id = $7`,
      [
        params.totalIssueCost,
        params.wipUnitCostCanonical,
        params.producedCanonicalTotal,
        WIP_COST_METHOD,
        params.now,
        params.executionId,
        params.tenantId
      ]
    );
    await projectionClient.query(
      `UPDATE work_orders
          SET quantity_completed = $2,
              status = $3,
              released_at = CASE
                WHEN $11 IN ('draft', 'ready') THEN COALESCE(released_at, $8)
                ELSE released_at
              END,
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
        WHERE id = $1
          AND tenant_id = $10`,
        [
          params.workOrderId,
          params.newCompleted,
          params.newStatus,
          params.completedAt,
          params.totalIssueCost,
          params.producedCanonicalTotal,
          WIP_COST_METHOD,
          params.now,
          params.now,
          params.tenantId,
          normalizeWorkOrderStatus(params.workOrder.status)
        ]
      );

    if (params.validationOverrideMetadata && params.context.actor) {
      await recordAuditLog(
        {
          tenantId: params.tenantId,
          actorType: params.context.actor.type,
          actorId: params.context.actor.id ?? null,
          action: 'negative_override',
          entityType: 'inventory_movement',
          entityId: params.issueMovementId,
          occurredAt: params.now,
          metadata: {
            reason: params.validationOverrideMetadata.override_reason ?? null,
            workOrderId: params.workOrderId,
            executionId: params.executionId,
            reference: params.validationOverrideMetadata.override_reference ?? null,
            lines: params.consumeLinesOrdered.map((line) => ({
              itemId: line.componentItemId,
              locationId: line.fromLocationId,
              uom: line.uom,
              quantity: roundQuantity(line.quantity)
            }))
          }
        },
        projectionClient
      );
    }
  });
  return projectionOps;
}

export function buildVoidProjectionOps(params: {
  tenantId: string;
  workOrderId: string;
  executionId: string;
  outputReversalMovementId: string;
  componentReturnMovementId: string;
  reason: string;
  actor: { type: 'user' | 'system'; id?: string | null };
  now: Date;
}): InventoryCommandProjectionOp[] {
  return [
    async (projectionClient) => {
      await recordAuditLog(
        {
          tenantId: params.tenantId,
          actorType: params.actor.type,
          actorId: params.actor.id ?? null,
          action: 'update',
          entityType: 'work_order_execution',
          entityId: params.executionId,
          occurredAt: params.now,
          metadata: {
            workOrderId: params.workOrderId,
            workOrderExecutionId: params.executionId,
            outputReversalMovementId: params.outputReversalMovementId,
            componentReturnMovementId: params.componentReturnMovementId,
            reason: params.reason
          }
        },
        projectionClient
      );
    }
  ];
}

export function buildScrapProjectionOps(params: {
  tenantId: string;
  workOrderId: string;
  quantity: number;
  now: Date;
  created: boolean;
}): InventoryCommandProjectionOp[] {
  if (!params.created) {
    return [];
  }
  return [
    async (projectionClient) => {
      await projectionClient.query(
        `UPDATE work_orders
            SET quantity_scrapped = COALESCE(quantity_scrapped, 0) + $1,
                status = CASE
                  WHEN COALESCE(quantity_completed, 0) + COALESCE(quantity_scrapped, 0) + $1 >= quantity_planned
                    THEN 'completed'
                  WHEN COALESCE(quantity_completed, 0) > 0 OR COALESCE(quantity_scrapped, 0) + $1 > 0
                    THEN 'partially_completed'
                  ELSE status
                END,
                completed_at = CASE
                  WHEN COALESCE(quantity_completed, 0) + COALESCE(quantity_scrapped, 0) + $1 >= quantity_planned
                    THEN COALESCE(completed_at, $2)
                  ELSE completed_at
                END,
                updated_at = $2
          WHERE id = $3
            AND tenant_id = $4`,
        [params.quantity, params.now, params.workOrderId, params.tenantId]
      );
    }
  ];
}
