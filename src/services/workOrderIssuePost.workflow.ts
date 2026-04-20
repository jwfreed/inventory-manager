import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { validateSufficientStock } from './stockValidation.service';
import {
  applyPlannedCostLayerConsumption,
  planCostLayerConsumption
} from './costLayers.service';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import { persistInventoryMovement } from '../domains/inventory';
import {
  runInventoryCommand,
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import {
  buildPostedDocumentReplayResult,
  buildInventoryBalanceProjectionOp,
  buildRefreshItemCostSummaryProjectionOp
} from '../modules/platform/application/inventoryMutationSupport';
import { isTerminalWorkOrderStatus } from './workOrderLifecycle.service';
import {
  consumeWorkOrderReservations,
  ensureWorkOrderReservationsReady
} from './inventoryReservation.service';
import * as movementPlanner from './inventoryMovementPlanner';
import * as replayEngine from './inventoryReplayEngine';
import * as statePolicy from './inventoryStatePolicy';
import * as eventFactory from './inventoryEventFactory';
import * as wipEngine from './wipAccountingEngine';
import * as projectionEngine from './inventoryProjectionEngine';
import { compareIssueLineLockKey } from './workOrderExecution.ordering';
import { mapMaterialIssue } from './workOrderExecution.response';
import type {
  ManufacturingMutationState,
  NegativeOverrideContext,
  WorkOrderMaterialIssueLineRow,
  WorkOrderMaterialIssueRow,
  WorkOrderRow
} from './workOrderExecution.types';

type WorkOrderIssueRecord = ReturnType<typeof mapMaterialIssue>;
type WorkOrderIssueReplayResult = Awaited<ReturnType<typeof replayEngine.replayIssue>> & {
  responseBody: WorkOrderIssueRecord;
};

type DomainError = Error & {
  code?: string;
  details?: Record<string, unknown>;
};

const WORK_ORDER_POST_RETRY_OPTIONS = { isolationLevel: 'SERIALIZABLE' as const, retries: 8 };

function domainError(code: string, details?: Record<string, unknown>): DomainError {
  const error = new Error(code) as DomainError;
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

async function fetchWorkOrderById(
  tenantId: string,
  id: string,
  client?: PoolClient,
  options?: { forUpdate?: boolean }
): Promise<WorkOrderRow | null> {
  const executor = client ? client.query.bind(client) : query;
  const lockClause = client && options?.forUpdate ? ' FOR UPDATE' : '';
  const result = await executor<WorkOrderRow>(
    `SELECT *
       FROM work_orders
      WHERE id = $1
        AND tenant_id = $2${lockClause}`,
    [id, tenantId]
  );
  return result.rowCount === 0 ? null : result.rows[0];
}

async function buildWorkOrderIssueReplayResult(params: {
  tenantId: string;
  workOrderId: string;
  issueId: string;
  movementId: string;
  expectedLineCount?: number;
  expectedDeterministicHash?: string | null;
  client: PoolClient;
  idempotencyKey?: string | null;
  preFetchIntegrityCheck?: () => Promise<void>;
  fetchAggregateView: () => Promise<WorkOrderIssueRecord | null>;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount,
        expectedDeterministicHash: params.expectedDeterministicHash ?? null
      }
    ],
    client: params.client,
    preFetchIntegrityCheck: params.preFetchIntegrityCheck,
    fetchAggregateView: params.fetchAggregateView,
    aggregateNotFoundError: new Error('WO_ISSUE_NOT_FOUND'),
    authoritativeEvents: [
      eventFactory.buildInventoryMovementPostedEvent(params.movementId, params.idempotencyKey ?? null),
      eventFactory.buildWorkOrderIssuePostedEvent({
        issueId: params.issueId,
        workOrderId: params.workOrderId,
        movementId: params.movementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
}

function deriveIssueMutationState(issue: WorkOrderMaterialIssueRow): ManufacturingMutationState {
  if (issue.status === 'draft') {
    return 'planned_issue';
  }
  if (issue.status === 'posted' && issue.inventory_movement_id) {
    return 'posted_issue';
  }
  throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
    flow: 'issue',
    issueId: issue.id,
    reason: issue.status === 'posted'
      ? 'posted_issue_missing_authoritative_movement'
      : 'issue_state_unrecognized'
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
  let workOrder: WorkOrderRow | null = null;
  let issue: WorkOrderMaterialIssueRow | null = null;
  let issueState: ManufacturingMutationState | null = null;
  let linesForPosting: WorkOrderMaterialIssueLineRow[] = [];
  let warehouseIdsByLocation = new Map<string, string>();

  return runInventoryCommand<WorkOrderIssueRecord>({
    tenantId,
    endpoint: 'wo.issue.post',
    operation: 'work_order_issue_post',
    retryOptions: WORK_ORDER_POST_RETRY_OPTIONS,
    lockTargets: async (client) => {
      workOrder = await fetchWorkOrderById(tenantId, workOrderId, client, { forUpdate: true });
      if (!workOrder) {
        throw new Error('WO_NOT_FOUND');
      }
      if (isTerminalWorkOrderStatus(workOrder.status)) {
        throw new Error('WO_INVALID_STATE');
      }

      const issueResult = await client.query<WorkOrderMaterialIssueRow>(
        `SELECT *
           FROM work_order_material_issues
          WHERE id = $1
            AND work_order_id = $2
            AND tenant_id = $3
          FOR UPDATE`,
        [issueId, workOrderId, tenantId]
      );
      if (issueResult.rowCount === 0) {
        throw new Error('WO_ISSUE_NOT_FOUND');
      }
      issue = issueResult.rows[0];
      if (issue.status === 'canceled') {
        throw new Error('WO_ISSUE_CANCELED');
      }
      issueState = deriveIssueMutationState(issue);
      if (issueState === 'posted_issue') {
        if (!issue.inventory_movement_id) {
          throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
            flow: 'issue',
            issueId,
            reason: 'posted_issue_missing_authoritative_movement'
          });
        }
        return [];
      }

      const linesResult = await client.query<WorkOrderMaterialIssueLineRow>(
        `SELECT *
           FROM work_order_material_issue_lines
          WHERE work_order_material_issue_id = $1
            AND tenant_id = $2
          ORDER BY line_number ASC`,
        [issueId, tenantId]
      );
      if (linesResult.rowCount === 0) {
        throw new Error('WO_ISSUE_NO_LINES');
      }
      linesForPosting = [...linesResult.rows].sort(compareIssueLineLockKey);
      warehouseIdsByLocation = new Map<string, string>();
      for (const line of linesForPosting) {
        if (!warehouseIdsByLocation.has(line.from_location_id)) {
          warehouseIdsByLocation.set(
            line.from_location_id,
            await resolveWarehouseIdForLocation(tenantId, line.from_location_id, client)
          );
        }
      }
      await ensureWorkOrderReservationsReady(tenantId, workOrderId, client);
      return linesForPosting.map((line) => ({
        tenantId,
        warehouseId: warehouseIdsByLocation.get(line.from_location_id) ?? '',
        itemId: line.component_item_id
      }));
    },
    execute: async ({ client }) => {
      if (!workOrder || !issue || !issueState) {
        throw new Error('WO_ISSUE_NOT_FOUND');
      }

      const isDisassembly = workOrder.kind === 'disassembly';
      const workOrderNumber = workOrder.number ?? workOrder.work_order_number;
      const issuedTotal = linesForPosting.reduce(
        (sum, line) => sum + toNumber(line.quantity_issued),
        0
      );
      const lineById = new Map<string, WorkOrderMaterialIssueLineRow>();
      const plannerLines: movementPlanner.RawMovementLineDescriptor[] = [];
      for (const line of linesForPosting) {
        if (isDisassembly && line.component_item_id !== workOrder.output_item_id) {
          throw new Error('WO_DISASSEMBLY_INPUT_MISMATCH');
        }
        const qty = toNumber(line.quantity_issued);
        if (qty <= 0) {
          throw new Error('WO_ISSUE_INVALID_QUANTITY');
        }
        lineById.set(line.id, line);
        plannerLines.push({
          sourceLineId: line.id,
          warehouseId: warehouseIdsByLocation.get(line.from_location_id) ?? '',
          itemId: line.component_item_id,
          locationId: line.from_location_id,
          quantity: -qty,
          uom: line.uom,
          defaultReasonCode: isDisassembly ? 'disassembly_issue' : 'work_order_issue',
          explicitReasonCode: line.reason_code,
          lineNotes: line.notes ?? `Work order issue ${issueId} line ${line.line_number}`
        });
      }
      const occurredAt = new Date(issue.occurred_at);
      const baseIssueMovement = await movementPlanner.buildIssueMovement({
        client,
        header: {
          id: issue.inventory_movement_id ?? uuidv4(),
          tenantId,
          movementType: 'issue',
          status: 'posted',
          externalRef: isDisassembly
            ? `work_order_disassembly_issue:${issueId}:${workOrderId}`
            : `work_order_issue:${issueId}:${workOrderId}`,
          sourceType: 'work_order_issue_post',
          sourceId: issueId,
          idempotencyKey: `wo-issue-post:${issueId}`,
          occurredAt,
          postedAt: occurredAt,
          notes: issue.notes ?? null,
          metadata: null,
          createdAt: occurredAt,
          updatedAt: occurredAt
        },
        lines: plannerLines
      });
      const sortedMovementLines = baseIssueMovement.sortedLines;
      if (issueState === 'posted_issue') {
        const replay = await replayEngine.replayIssue({
          tenantId,
          workOrderId,
          issueId,
          movementId: issue.inventory_movement_id!,
          expectedLineCount: baseIssueMovement.expectedLineCount,
          expectedDeterministicHash: baseIssueMovement.expectedDeterministicHash,
          client,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
          },
          fetchAggregateView: () =>
            fetchWorkOrderIssue(tenantId, workOrderId, issueId, client)
        }) as WorkOrderIssueReplayResult;
        return replay;
      }

      statePolicy.assertManufacturingTransition({
        flow: 'issue',
        currentState: issueState,
        allowedFrom: ['planned_issue'],
        targetState: 'posted_issue',
        workOrderId,
        executionOrDocumentId: issueId
      });

      const now = new Date();
      const validation = await validateSufficientStock(
        tenantId,
        occurredAt,
        linesForPosting.map((line) => ({
          warehouseId: warehouseIdsByLocation.get(line.from_location_id) ?? '',
          itemId: line.component_item_id,
          locationId: line.from_location_id,
          uom: line.uom,
          quantityToConsume: roundQuantity(toNumber(line.quantity_issued))
        })),
        {
          actorId: context.actor?.id ?? null,
          actorRole: context.actor?.role ?? null,
          overrideRequested: context.overrideRequested,
          overrideReason: context.overrideReason ?? null,
          overrideReference: `work_order_issue:${issueId}`
        },
        { client }
      );

      const movementId = uuidv4();
      const plannedMovementLines: Array<{
        preparedLine: (typeof sortedMovementLines)[number];
        sourceLine: WorkOrderMaterialIssueLineRow;
        issueCost: number | null;
        consumptionPlan: Awaited<ReturnType<typeof planCostLayerConsumption>>;
      }> = [];
      for (const preparedLine of sortedMovementLines) {
        const sourceLine = lineById.get(preparedLine.sourceLineId);
        if (!sourceLine) {
          throw new Error('WO_ISSUE_LINE_NOT_FOUND');
        }
        const canonicalQty = Math.abs(preparedLine.canonicalFields.quantityDeltaCanonical);
        let consumptionPlan: Awaited<ReturnType<typeof planCostLayerConsumption>>;
        try {
          consumptionPlan = await planCostLayerConsumption({
            tenant_id: tenantId,
            item_id: sourceLine.component_item_id,
            location_id: sourceLine.from_location_id,
            quantity: canonicalQty,
            consumption_type: 'production_input',
            consumption_document_id: issueId,
            movement_id: movementId,
            client
          });
        } catch {
          throw new Error('WO_WIP_COST_LAYERS_MISSING');
        }
        plannedMovementLines.push({
          preparedLine,
          sourceLine,
          issueCost: consumptionPlan.total_cost,
          consumptionPlan
        });
      }

      const plannedIssueMovement = await movementPlanner.buildIssueMovement({
        client,
        header: {
          id: movementId,
          tenantId,
          movementType: 'issue',
          status: 'posted',
          externalRef: isDisassembly
            ? `work_order_disassembly_issue:${issueId}:${workOrderId}`
            : `work_order_issue:${issueId}:${workOrderId}`,
          sourceType: 'work_order_issue_post',
          sourceId: issueId,
          idempotencyKey: `wo-issue-post:${issueId}`,
          occurredAt,
          postedAt: now,
          notes: issue.notes ?? null,
          metadata: {
            workOrderId,
            workOrderNumber,
            ...(validation.overrideMetadata ?? {})
          },
          createdAt: now,
          updatedAt: now
        },
        lines: plannedMovementLines.map(({ preparedLine, sourceLine, issueCost }) => {
          const canonicalQty = Math.abs(preparedLine.canonicalFields.quantityDeltaCanonical);
          const unitCost = issueCost !== null && canonicalQty !== 0 ? issueCost / canonicalQty : null;
          const extendedCost = issueCost !== null ? -issueCost : null;
          return {
            sourceLineId: preparedLine.sourceLineId,
            warehouseId: preparedLine.warehouseId,
            itemId: sourceLine.component_item_id,
            locationId: sourceLine.from_location_id,
            quantity: toNumber(sourceLine.quantity_issued) * -1,
            uom: sourceLine.uom,
            defaultReasonCode: isDisassembly ? 'disassembly_issue' : 'work_order_issue',
            explicitReasonCode: sourceLine.reason_code,
            lineNotes: sourceLine.notes ?? `Work order issue ${issueId} line ${sourceLine.line_number}`,
            unitCost,
            extendedCost
          };
        })
      });
      const movement = await persistInventoryMovement(client, plannedIssueMovement.persistInput);

      if (!movement.created) {
        const replay = await replayEngine.replayIssue({
          tenantId,
          workOrderId,
          issueId,
          movementId: movement.movementId,
          expectedLineCount: plannedIssueMovement.expectedLineCount,
          expectedDeterministicHash: plannedIssueMovement.expectedDeterministicHash,
          client,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
          },
          fetchAggregateView: () =>
            fetchWorkOrderIssue(tenantId, workOrderId, issueId, client)
        }) as WorkOrderIssueReplayResult;
        return replay;
      }

      let totalIssueCost = 0;
      const projectionOps: InventoryCommandProjectionOp[] = [];
      const itemsToRefresh = new Set<string>();
      for (const { preparedLine, sourceLine, issueCost, consumptionPlan } of plannedMovementLines) {
        const canonicalQty = Math.abs(preparedLine.canonicalFields.quantityDeltaCanonical);
        await applyPlannedCostLayerConsumption({
          tenant_id: tenantId,
          item_id: sourceLine.component_item_id,
          location_id: sourceLine.from_location_id,
          quantity: canonicalQty,
          consumption_type: 'production_input',
          consumption_document_id: issueId,
          movement_id: movement.movementId,
          client,
          plan: consumptionPlan
        });
        totalIssueCost += issueCost ?? 0;
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: sourceLine.component_item_id,
            locationId: sourceLine.from_location_id,
            uom: preparedLine.canonicalFields.canonicalUom,
            deltaOnHand: preparedLine.canonicalFields.quantityDeltaCanonical
          })
        );
        itemsToRefresh.add(sourceLine.component_item_id);
      }

      for (const itemId of itemsToRefresh.values()) {
        projectionOps.push(buildRefreshItemCostSummaryProjectionOp(tenantId, itemId));
      }

      await wipEngine.createWipValuationRecord(client, {
        tenantId,
        workOrderId,
        executionId: null,
        movementId: movement.movementId,
        valuationType: 'issue',
        valueDelta: totalIssueCost,
        notes: `Work-order issue WIP valuation for issue ${issueId}`
      });
      await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
      await consumeWorkOrderReservations(
        tenantId,
        workOrderId,
        linesForPosting.map((line) => ({
          componentItemId: line.component_item_id,
          locationId: line.from_location_id,
          uom: line.uom,
          quantity: roundQuantity(toNumber(line.quantity_issued))
        })),
        client
      );
      projectionOps.push(
        ...projectionEngine.buildIssueProjectionOps({
          tenantId,
          issueId,
          movementId: movement.movementId,
          now,
          workOrderId,
          workOrder,
          isDisassembly,
          issuedTotal,
          validationOverrideMetadata: validation.overrideMetadata ?? null,
          context,
          linesForPosting
        })
      );

      return {
        responseBody: mapMaterialIssue(
          {
            ...issue,
            status: 'posted',
            inventory_movement_id: movement.movementId,
            updated_at: now.toISOString()
          },
          linesForPosting
        ),
        responseStatus: 200,
        events: [
          eventFactory.buildInventoryMovementPostedEvent(movement.movementId),
          eventFactory.buildWorkOrderIssuePostedEvent({
            issueId,
            workOrderId,
            movementId: movement.movementId
          })
        ],
        projectionOps
      };
    }
  });
}
