import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { roundQuantity, toNumber } from '../lib/numbers';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import { hashTransactionalIdempotencyRequest } from '../lib/transactionalIdempotency';
import {
  runInventoryCommand
} from '../modules/platform/application/runInventoryCommand';
import {
  buildPostedDocumentReplayResult
} from '../modules/platform/application/inventoryMutationSupport';
import * as replayEngine from './inventoryReplayEngine';
import * as wipEngine from './wipAccountingEngine';
import * as eventFactory from './inventoryEventFactory';
import * as lotTraceability from './lotTraceabilityEngine';
import {
  executeWorkOrderBatchPosting
} from '../domain/workOrders/batchExecution';
import {
  planWorkOrderBatch
} from '../domain/workOrders/batchPlan';
import {
  evaluateWorkOrderBatchPolicy,
  type WorkOrderBatchPolicy
} from '../domain/workOrders/batchPolicy';
import {
  hashNormalizedBatchRequest,
  normalizeBatchRequestPayload,
  type NormalizedBatchConsumeLine,
  type NormalizedBatchProduceLine
} from './workOrderExecution.request';
import {
  workOrderBatchSchema
} from '../schemas/workOrderExecution.schema';
import type { NegativeOverrideContext } from './workOrderExecution.types';

type WorkOrderBatchInput = z.infer<typeof workOrderBatchSchema>;

export type WorkOrderBatchResult = {
  workOrderId: string;
  executionId: string;
  issueMovementId: string;
  receiveMovementId: string;
  quantityCompleted: number;
  workOrderStatus: string;
  idempotencyKey: string | null;
  replayed: boolean;
};

const WORK_ORDER_POST_RETRY_OPTIONS = { isolationLevel: 'SERIALIZABLE' as const, retries: 8 };

async function buildWorkOrderBatchReplayResult(params: {
  tenantId: string;
  workOrderId: string;
  executionId: string;
  issueMovementId: string;
  receiveMovementId: string;
  expectedIssueLineCount?: number;
  expectedReceiveLineCount?: number;
  expectedIssueDeterministicHash?: string | null;
  expectedReceiveDeterministicHash?: string | null;
  client: PoolClient;
  idempotencyKey?: string | null;
  preFetchIntegrityCheck: () => Promise<void>;
  fetchAggregateView: () => Promise<WorkOrderBatchResult | null>;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.issueMovementId,
        expectedLineCount: params.expectedIssueLineCount,
        expectedDeterministicHash: params.expectedIssueDeterministicHash ?? null
      },
      {
        movementId: params.receiveMovementId,
        expectedLineCount: params.expectedReceiveLineCount,
        expectedDeterministicHash: params.expectedReceiveDeterministicHash ?? null
      }
    ],
    client: params.client,
    preFetchIntegrityCheck: params.preFetchIntegrityCheck,
    fetchAggregateView: params.fetchAggregateView,
    aggregateNotFoundError: new Error('WO_EXECUTION_NOT_FOUND'),
    authoritativeEvents: [
      eventFactory.buildInventoryMovementPostedEvent(params.issueMovementId, params.idempotencyKey ?? null),
      eventFactory.buildInventoryMovementPostedEvent(params.receiveMovementId, params.idempotencyKey ?? null),
      eventFactory.buildWorkOrderProductionReportedEvent({
        executionId: params.executionId,
        workOrderId: params.workOrderId,
        issueMovementId: params.issueMovementId,
        receiveMovementId: params.receiveMovementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
}

export async function recordWorkOrderBatch(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderBatchInput,
  context: NegativeOverrideContext = {},
  options?: {
    idempotencyKey?: string | null;
    idempotencyEndpoint?: string;
    traceability?: {
      outputItemId: string;
      outputQty: number;
      outputUom: string;
      outputLotId?: string | null;
      outputLotCode?: string | null;
      productionBatchId?: string | null;
      inputLots?: ReadonlyArray<lotTraceability.WorkOrderInputLotLink>;
      workOrderNumber: string;
      occurredAt: Date;
    };
  }
): Promise<WorkOrderBatchResult> {
  const batchIdempotencyKey = options?.idempotencyKey?.trim() ? options.idempotencyKey.trim() : null;
  const idempotencyEndpoint = options?.idempotencyEndpoint ?? IDEMPOTENCY_ENDPOINTS.WORK_ORDER_RECORD_BATCH;
  const normalizedConsumes: NormalizedBatchConsumeLine[] = data.consumeLines.map((line) => {
    const quantity = toNumber(line.quantity);
    if (quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_CONSUME_QTY');
    }
    return {
      componentItemId: line.componentItemId,
      fromLocationId: line.fromLocationId,
      quantity,
      uom: line.uom,
      reasonCode: line.reasonCode ?? null,
      notes: line.notes ?? null
    };
  });
  const normalizedProduces: NormalizedBatchProduceLine[] = data.produceLines.map((line) => {
    const quantity = toNumber(line.quantity);
    if (quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_PRODUCE_QTY');
    }
    return {
      outputItemId: line.outputItemId,
      toLocationId: line.toLocationId,
      quantity,
      uom: line.uom,
      reasonCode: line.reasonCode ?? null,
      packSize: line.packSize ?? null,
      notes: line.notes ?? null
    };
  });
  const occurredAt = new Date(data.occurredAt);
  const normalizedRequestPayload = normalizeBatchRequestPayload({
    workOrderId,
    occurredAt,
    notes: data.notes ?? null,
    overrideNegative: data.overrideNegative,
    overrideReason: data.overrideReason ?? null,
    consumeLines: normalizedConsumes,
    produceLines: normalizedProduces
  });
  const requestHash = hashNormalizedBatchRequest(normalizedRequestPayload);
  const transactionalRequestHash = batchIdempotencyKey
    ? hashTransactionalIdempotencyRequest({
      method: 'POST',
      endpoint: idempotencyEndpoint,
      body: normalizedRequestPayload
    })
    : null;
  let batchPolicy: WorkOrderBatchPolicy | null = null;

  return runInventoryCommand<WorkOrderBatchResult>({
    tenantId,
    endpoint: idempotencyEndpoint,
    operation: 'work_order_batch_post',
    idempotencyKey: batchIdempotencyKey,
    requestHash: transactionalRequestHash,
    retryOptions: WORK_ORDER_POST_RETRY_OPTIONS,
    onReplay: async ({ client, responseBody }) => {
      const replay = await replayEngine.replayBatch({
          tenantId,
          workOrderId: responseBody.workOrderId,
          executionId: responseBody.executionId,
          issueMovementId: responseBody.issueMovementId,
          receiveMovementId: responseBody.receiveMovementId,
          expectedIssueLineCount: normalizedConsumes.length,
          expectedReceiveLineCount: normalizedProduces.length,
          client,
          idempotencyKey: batchIdempotencyKey,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, responseBody.workOrderId);
          },
          fetchAggregateView: async () => {
            const res = await client.query<{
              execution_id: string;
              work_order_id: string;
              quantity_completed: string | number | null;
              work_order_status: string;
            }>(
              `SELECT e.id AS execution_id,
                      e.work_order_id,
                      w.quantity_completed,
                      w.status AS work_order_status
                 FROM work_order_executions e
                 JOIN work_orders w
                   ON w.id = e.work_order_id
                  AND w.tenant_id = e.tenant_id
                WHERE e.tenant_id = $1
                  AND e.id = $2
                  AND e.work_order_id = $3
                FOR UPDATE OF e`,
              [tenantId, responseBody.executionId, responseBody.workOrderId]
            );
            const row = res.rows[0];
            if (!row) {
              return null;
            }
            return {
              workOrderId: row.work_order_id,
              executionId: row.execution_id,
              issueMovementId: responseBody.issueMovementId,
              receiveMovementId: responseBody.receiveMovementId,
              quantityCompleted: roundQuantity(toNumber(row.quantity_completed ?? 0)),
              workOrderStatus: row.work_order_status,
              idempotencyKey: batchIdempotencyKey,
              replayed: true
            };
          }
        });
      return replay.responseBody as WorkOrderBatchResult;
    },
    lockTargets: async (client) => {
      batchPolicy = await evaluateWorkOrderBatchPolicy({
        tenantId,
        workOrderId,
        batchIdempotencyKey,
        requestHash,
        normalizedConsumes,
        normalizedProduces,
        client
      });
      return batchPolicy.existingBatchReplay ? [] : [...batchPolicy.lockTargets];
    },
    execute: async ({ client }) => {
      if (!batchPolicy) {
        throw new Error('WO_NOT_FOUND');
      }
      if (batchPolicy.existingBatchReplay) {
        const replay = await replayEngine.replayBatch({
          tenantId,
          workOrderId: batchPolicy.existingBatchReplay.workOrderId,
          executionId: batchPolicy.existingBatchReplay.executionId,
          issueMovementId: batchPolicy.existingBatchReplay.issueMovementId,
          receiveMovementId: batchPolicy.existingBatchReplay.receiveMovementId,
          expectedIssueLineCount: normalizedConsumes.length,
          expectedReceiveLineCount: normalizedProduces.length,
          client,
          idempotencyKey: batchIdempotencyKey,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, batchPolicy!.existingBatchReplay!.workOrderId);
          },
          fetchAggregateView: async () => ({
            workOrderId: batchPolicy!.existingBatchReplay!.workOrderId,
            executionId: batchPolicy!.existingBatchReplay!.executionId,
            issueMovementId: batchPolicy!.existingBatchReplay!.issueMovementId,
            receiveMovementId: batchPolicy!.existingBatchReplay!.receiveMovementId,
            quantityCompleted: batchPolicy!.existingBatchReplay!.quantityCompleted,
            workOrderStatus: batchPolicy!.existingBatchReplay!.workOrderStatus,
            idempotencyKey: batchIdempotencyKey,
            replayed: true
          })
        });
        return {
          ...replay,
          responseBody: replay.responseBody as WorkOrderBatchResult
        };
      }
      const batchPlan = await planWorkOrderBatch({
        tenantId,
        workOrderId,
        policy: batchPolicy,
        client
      });
      return executeWorkOrderBatchPosting({
        tenantId,
        workOrderId,
        policy: batchPolicy,
        plan: batchPlan,
        occurredAt,
        notes: data.notes ?? null,
        context,
        batchIdempotencyKey,
        requestHash,
        traceability: options?.traceability ?? null,
        client
      });
    }
  });
}
