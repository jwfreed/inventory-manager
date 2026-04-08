import type { PoolClient } from 'pg';
import { hashTransactionalIdempotencyRequest } from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import { runInventoryCommand } from '../modules/platform/application/runInventoryCommand';
import {
  buildMovementPostedEvent,
  buildPostedDocumentReplayResult,
  buildRefreshItemCostSummaryProjectionOp,
  buildReplayCorruptionError
} from '../modules/platform/application/inventoryMutationSupport';
import { buildReplayDeterminismExpectation } from '../domain/inventory/mutationInvariants';
import {
  buildReturnReceiptMovementPlan,
  evaluateReturnReceiptPostPolicy,
  executeReturnReceiptMovementPlan
} from '../domain/returns/receiptPosting';
import {
  buildReturnDispositionMovementPlan,
  evaluateReturnDispositionPostPolicy,
  executeReturnDispositionMovementPlan
} from '../domain/returns/dispositionPosting';
import {
  classifyReturnPostingState,
  repairReturnPostingRecoveryState,
  type ReturnPostingDocumentKind,
  type ReturnPostingStateClassification
} from '../domain/returns/returnPostingState';

export type ReturnPostingType = ReturnPostingDocumentKind;

type ReturnPostingReplayExpectation = Readonly<{
  expectedLineCount: number;
  expectedDeterministicHash?: string | null;
}>;

type EvaluatePolicyArgs = Readonly<{
  client: PoolClient;
  tenantId: string;
  document: any;
  lines: ReadonlyArray<any>;
}>;

type BuildPlanArgs = EvaluatePolicyArgs & Readonly<{
  policy: any;
  idempotencyKey: string;
}>;

type ExecutePlanArgs = Readonly<{
  client: PoolClient;
  tenantId: string;
  documentId: string;
  plan: any;
  occurredAt: Date;
}>;

type BuildLockTargetsArgs = Readonly<{
  tenantId: string;
  policy: any;
}>;

type ReturnPostingConfig = Readonly<{
  type: ReturnPostingType;
  endpoint: string;
  operation: string;
  documentTable: 'return_receipts' | 'return_dispositions';
  linesTable: 'return_receipt_lines' | 'return_disposition_lines';
  linesForeignKey: 'return_receipt_id' | 'return_disposition_id';
  lineOrderBySql: string;
  documentIdKey: 'returnReceiptId' | 'returnDispositionId';
  notFoundErrorCode: string;
  canceledErrorCode: string;
  noLinesErrorCode: string;
  policyRequiredErrorCode: string;
  recoveryIrrecoverableCode:
    | 'RETURN_RECEIPT_RECOVERY_IRRECOVERABLE'
    | 'RETURN_DISPOSITION_RECOVERY_IRRECOVERABLE';
  replayMovementMissingReason: string;
  replayRepairFailedReason: string;
  buildRequestBody: (documentId: string) => Record<string, string>;
  buildReplayExpectationFromAggregate: (responseBody: any) => ReturnPostingReplayExpectation;
  buildReplayExpectationFromLockedLines: (lines: ReadonlyArray<any>) => ReturnPostingReplayExpectation;
  buildReplayExpectationFromPlan: (plan: any) => ReturnPostingReplayExpectation;
  evaluatePolicy: (params: EvaluatePolicyArgs) => Promise<any>;
  buildPlan: (params: BuildPlanArgs) => Promise<any>;
  executePlan: (params: ExecutePlanArgs) => Promise<{
    movementId: string;
    created: boolean;
    projectionOps: ReadonlyArray<(client: PoolClient) => Promise<void>>;
  }>;
  buildLockTargets: (params: BuildLockTargetsArgs) => Array<{
    tenantId: string;
    warehouseId: string;
    itemId: string;
  }>;
  buildPostProjectionOps: (params: BuildLockTargetsArgs) => ReadonlyArray<(client: PoolClient) => Promise<void>>;
}>;

type LockedReturnPostingContext = Readonly<{
  document: any;
  lines: ReadonlyArray<any>;
}>;

type ReturnPostingBranch = 'POSTABLE' | 'REPLAY' | 'TERMINAL_CANCELED' | 'IRRECOVERABLE';

const RETURN_POSTING_CONFIG: Record<ReturnPostingType, ReturnPostingConfig> = Object.freeze({
  receipt: Object.freeze({
    type: 'receipt',
    endpoint: IDEMPOTENCY_ENDPOINTS.RETURN_RECEIPTS_POST,
    operation: 'return_receipt_post',
    documentTable: 'return_receipts',
    linesTable: 'return_receipt_lines',
    linesForeignKey: 'return_receipt_id',
    lineOrderBySql: 'created_at ASC',
    documentIdKey: 'returnReceiptId',
    notFoundErrorCode: 'RETURN_RECEIPT_NOT_FOUND',
    canceledErrorCode: 'RETURN_RECEIPT_CANCELED',
    noLinesErrorCode: 'RETURN_RECEIPT_NO_LINES',
    policyRequiredErrorCode: 'RETURN_RECEIPT_POLICY_REQUIRED',
    recoveryIrrecoverableCode: 'RETURN_RECEIPT_RECOVERY_IRRECOVERABLE',
    replayMovementMissingReason: 'return_receipt_post_replay_movement_missing',
    replayRepairFailedReason: 'return_receipt_replay_repair_failed_closed',
    buildRequestBody: (documentId: string) => ({ returnReceiptId: documentId }),
    buildReplayExpectationFromAggregate: (responseBody: any) => ({
      expectedLineCount: Array.isArray(responseBody?.lines) ? responseBody.lines.length : 0
    }),
    buildReplayExpectationFromLockedLines: (lines: ReadonlyArray<any>) => ({
      expectedLineCount: lines.length
    }),
    buildReplayExpectationFromPlan: (plan: any) => ({
      expectedLineCount: plan.movement.expectedLineCount,
      expectedDeterministicHash: plan.movement.expectedDeterministicHash
    }),
    evaluatePolicy: async ({ client, tenantId, document, lines }: EvaluatePolicyArgs) =>
      evaluateReturnReceiptPostPolicy({
        client,
        tenantId,
        receipt: document,
        receiptLines: lines
      }),
    buildPlan: async ({ client, tenantId, document, lines, policy, idempotencyKey }: BuildPlanArgs) =>
      buildReturnReceiptMovementPlan({
        client,
        tenantId,
        receipt: document,
        receiptLines: lines,
        policy,
        idempotencyKey
      }),
    executePlan: async ({ client, tenantId, documentId, plan, occurredAt }: ExecutePlanArgs) =>
      executeReturnReceiptMovementPlan({
        client,
        tenantId,
        receiptId: documentId,
        plan,
        occurredAt
      }),
    buildLockTargets: ({ tenantId, policy }: BuildLockTargetsArgs) =>
      policy.itemIdsToLock.map((itemId: string) => ({
        tenantId,
        warehouseId: policy.warehouseId,
        itemId
      })),
    buildPostProjectionOps: ({ tenantId, policy }: BuildLockTargetsArgs) =>
      policy.itemIdsToLock.map((itemId: string) => buildRefreshItemCostSummaryProjectionOp(tenantId, itemId))
  }),
  disposition: Object.freeze({
    type: 'disposition',
    endpoint: IDEMPOTENCY_ENDPOINTS.RETURN_DISPOSITIONS_POST,
    operation: 'return_disposition_post',
    documentTable: 'return_dispositions',
    linesTable: 'return_disposition_lines',
    linesForeignKey: 'return_disposition_id',
    lineOrderBySql: 'line_number ASC NULLS LAST, created_at ASC',
    documentIdKey: 'returnDispositionId',
    notFoundErrorCode: 'RETURN_DISPOSITION_NOT_FOUND',
    canceledErrorCode: 'RETURN_DISPOSITION_CANCELED',
    noLinesErrorCode: 'RETURN_DISPOSITION_NO_LINES',
    policyRequiredErrorCode: 'RETURN_DISPOSITION_POLICY_REQUIRED',
    recoveryIrrecoverableCode: 'RETURN_DISPOSITION_RECOVERY_IRRECOVERABLE',
    replayMovementMissingReason: 'return_disposition_post_replay_movement_missing',
    replayRepairFailedReason: 'return_disposition_replay_repair_failed_closed',
    buildRequestBody: (documentId: string) => ({ returnDispositionId: documentId }),
    buildReplayExpectationFromAggregate: (responseBody: any) => ({
      expectedLineCount: Array.isArray(responseBody?.lines) ? responseBody.lines.length * 2 : 0
    }),
    buildReplayExpectationFromLockedLines: (lines: ReadonlyArray<any>) => ({
      expectedLineCount: lines.length * 2
    }),
    buildReplayExpectationFromPlan: (plan: any) => ({
      expectedLineCount: plan.movement.expectedLineCount,
      expectedDeterministicHash: plan.movement.expectedDeterministicHash
    }),
    evaluatePolicy: async ({ client, tenantId, document, lines }: EvaluatePolicyArgs) =>
      evaluateReturnDispositionPostPolicy({
        client,
        tenantId,
        disposition: document,
        dispositionLines: lines
      }),
    buildPlan: async ({ client, tenantId, document, lines, policy, idempotencyKey }: BuildPlanArgs) =>
      buildReturnDispositionMovementPlan({
        client,
        tenantId,
        disposition: document,
        dispositionLines: lines,
        policy,
        idempotencyKey
      }),
    executePlan: async ({ client, tenantId, documentId, plan, occurredAt }: ExecutePlanArgs) =>
      executeReturnDispositionMovementPlan({
        client,
        tenantId,
        dispositionId: documentId,
        plan,
        occurredAt
      }),
    buildLockTargets: ({ tenantId, policy }: BuildLockTargetsArgs) =>
      policy.itemIdsToLock.map((itemId: string) => ({
        tenantId,
        warehouseId: policy.warehouseId,
        itemId
      })),
    buildPostProjectionOps: () => []
  })
});

function isReturnReplayableState(
  state: ReturnPostingStateClassification['state']
) {
  return (
    state === 'VALID_COMPLETE'
    || state === 'RECOVERABLE_PARTIAL'
    || state === 'TOLERATED_DRIFT'
  );
}

function buildReturnRecoveryIrrecoverableError(params: {
  code: ReturnPostingConfig['recoveryIrrecoverableCode'];
  documentId: string;
  classification: ReturnPostingStateClassification;
}) {
  const error = new Error(params.code) as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = params.code;
  error.details = {
    documentId: params.documentId,
    state: params.classification.state,
    reason: params.classification.reason,
    authoritativeMovementId: params.classification.authoritativeMovementId,
    inventoryMovementId: params.classification.inventoryMovementId,
    documentStatus: params.classification.documentStatus,
    ...(params.classification.details ?? {})
  };
  return error;
}

function classifyReturnPostingBranch(
  classification: ReturnPostingStateClassification
): ReturnPostingBranch {
  if (classification.state === 'TERMINAL_CANCELED') {
    return 'TERMINAL_CANCELED';
  }
  if (classification.state === 'IRRECOVERABLE') {
    return 'IRRECOVERABLE';
  }
  if (isReturnReplayableState(classification.state)) {
    return 'REPLAY';
  }
  return 'POSTABLE';
}

function buildDocumentDetails(
  config: ReturnPostingConfig,
  documentId: string
) {
  return {
    [config.documentIdKey]: documentId
  };
}

async function loadLockedReturnPostingContext(params: {
  client: PoolClient;
  tenantId: string;
  documentId: string;
  config: ReturnPostingConfig;
}): Promise<LockedReturnPostingContext> {
  const documentResult = await params.client.query(
    `SELECT *
       FROM ${params.config.documentTable}
      WHERE id = $1
        AND tenant_id = $2
      FOR UPDATE`,
    [params.documentId, params.tenantId]
  );
  if ((documentResult.rowCount ?? 0) === 0) {
    throw new Error(params.config.notFoundErrorCode);
  }

  const document = documentResult.rows[0];
  if (document?.status === 'canceled') {
    throw new Error(params.config.canceledErrorCode);
  }

  const linesResult = await params.client.query(
    `SELECT *
       FROM ${params.config.linesTable}
      WHERE ${params.config.linesForeignKey} = $1
        AND tenant_id = $2
      ORDER BY ${params.config.lineOrderBySql}
      FOR UPDATE`,
    [params.documentId, params.tenantId]
  );
  if ((linesResult.rowCount ?? 0) === 0) {
    throw new Error(params.config.noLinesErrorCode);
  }

  return {
    document,
    lines: linesResult.rows
  };
}

async function buildReturnPostingReplayResult<T>(params: {
  config: ReturnPostingConfig;
  tenantId: string;
  documentId: string;
  movementId: string;
  expectation: ReturnPostingReplayExpectation;
  client: PoolClient;
  fetchAggregateView: (tenantId: string, documentId: string, client: PoolClient) => Promise<T | null>;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      buildReplayDeterminismExpectation({
        movementId: params.movementId,
        expectedLineCount: params.expectation.expectedLineCount,
        expectedDeterministicHash: params.expectation.expectedDeterministicHash ?? null
      })
    ],
    client: params.client,
    preFetchIntegrityCheck: async () => {
      const repaired = await repairReturnPostingRecoveryState({
        client: params.client,
        tenantId: params.tenantId,
        documentId: params.documentId,
        kind: params.config.type,
        movementId: params.movementId
      });
      if (repaired.state === 'TERMINAL_CANCELED') {
        throw new Error(params.config.canceledErrorCode);
      }
      if (!isReturnReplayableState(repaired.state) || repaired.authoritativeMovementId !== params.movementId) {
        throw buildReplayCorruptionError({
          tenantId: params.tenantId,
          ...buildDocumentDetails(params.config, params.documentId),
          movementId: params.movementId,
          reason: params.config.replayRepairFailedReason,
          state: repaired.state,
          repairActions: repaired.repairActions,
          details: repaired.details
        });
      }
    },
    fetchAggregateView: () => params.fetchAggregateView(params.tenantId, params.documentId, params.client),
    aggregateNotFoundError: new Error(params.config.notFoundErrorCode),
    authoritativeEvents: [
      buildMovementPostedEvent(params.movementId)
    ],
    responseStatus: 200
  });
}

export async function executeReturnPosting<T>(params: {
  type: ReturnPostingType;
  tenantId: string;
  documentId: string;
  idempotencyKey: string;
  fetchAggregateView: (tenantId: string, documentId: string, client: PoolClient) => Promise<T | null>;
}) {
  const config = RETURN_POSTING_CONFIG[params.type];
  const requestHash = hashTransactionalIdempotencyRequest({
    method: 'POST',
    endpoint: config.endpoint,
    body: config.buildRequestBody(params.documentId)
  });

  let postingContext: LockedReturnPostingContext | null = null;
  let postingClassification: ReturnPostingStateClassification | null = null;
  let postingPolicy: any = null;
  let postingPlan: any = null;

  return runInventoryCommand<T>({
    tenantId: params.tenantId,
    endpoint: config.endpoint,
    operation: config.operation,
    idempotencyKey: params.idempotencyKey,
    requestHash,
    retryOptions: { isolationLevel: 'SERIALIZABLE', retries: 2 },
    onReplay: async ({ client, responseBody }) => {
      const replayBody = responseBody as any;
      const replayMovementId = replayBody?.inventoryMovementId;
      if (typeof replayMovementId !== 'string' || !replayMovementId) {
        throw buildReplayCorruptionError({
          tenantId: params.tenantId,
          ...buildDocumentDetails(config, params.documentId),
          idempotencyKey: params.idempotencyKey,
          reason: config.replayMovementMissingReason
        });
      }

      const replayClassification = await classifyReturnPostingState({
        client,
        tenantId: params.tenantId,
        documentId: params.documentId,
        kind: params.type,
        expectedMovementId: replayMovementId
      });
      const replayBranch = classifyReturnPostingBranch(replayClassification);
      if (replayBranch === 'TERMINAL_CANCELED') {
        throw new Error(config.canceledErrorCode);
      }
      if (replayBranch !== 'REPLAY' || !replayClassification.authoritativeMovementId) {
        throw buildReturnRecoveryIrrecoverableError({
          code: config.recoveryIrrecoverableCode,
          documentId: params.documentId,
          classification: replayClassification
        });
      }

      return buildReturnPostingReplayResult({
        config,
        tenantId: params.tenantId,
        documentId: replayBody?.id ?? params.documentId,
        movementId: replayClassification.authoritativeMovementId,
        expectation: config.buildReplayExpectationFromAggregate(replayBody),
        client,
        fetchAggregateView: params.fetchAggregateView
      });
    },
    lockTargets: async (client) => {
      postingContext = await loadLockedReturnPostingContext({
        client,
        tenantId: params.tenantId,
        documentId: params.documentId,
        config
      });

      postingClassification = await classifyReturnPostingState({
        client,
        tenantId: params.tenantId,
        documentId: params.documentId,
        kind: params.type
      });
      const postingBranch = classifyReturnPostingBranch(postingClassification);
      if (postingBranch === 'IRRECOVERABLE') {
        throw buildReturnRecoveryIrrecoverableError({
          code: config.recoveryIrrecoverableCode,
          documentId: params.documentId,
          classification: postingClassification
        });
      }
      if (postingBranch === 'TERMINAL_CANCELED') {
        throw new Error(config.canceledErrorCode);
      }
      if (postingBranch === 'REPLAY') {
        return [];
      }

      postingPolicy = await config.evaluatePolicy({
        client,
        tenantId: params.tenantId,
        document: postingContext.document,
        lines: postingContext.lines
      });
      postingPlan = await config.buildPlan({
        client,
        tenantId: params.tenantId,
        document: postingContext.document,
        lines: postingContext.lines,
        policy: postingPolicy,
        idempotencyKey: params.idempotencyKey
      });
      return config.buildLockTargets({
        tenantId: params.tenantId,
        policy: postingPolicy
      });
    },
    execute: async ({ client }) => {
      if (
        postingClassification
        && classifyReturnPostingBranch(postingClassification) === 'REPLAY'
        && postingClassification.authoritativeMovementId
      ) {
        return buildReturnPostingReplayResult({
          config,
          tenantId: params.tenantId,
          documentId: params.documentId,
          movementId: postingClassification.authoritativeMovementId,
          expectation: config.buildReplayExpectationFromLockedLines(postingContext?.lines ?? []),
          client,
          fetchAggregateView: params.fetchAggregateView
        });
      }

      if (!postingPolicy || !postingPlan) {
        throw new Error(config.policyRequiredErrorCode);
      }

      const execution = await config.executePlan({
        client,
        tenantId: params.tenantId,
        documentId: params.documentId,
        plan: postingPlan,
        occurredAt: postingPolicy.occurredAt
      });

      await client.query(
        `UPDATE ${config.documentTable}
            SET status = 'posted',
                inventory_movement_id = $1
          WHERE id = $2
            AND tenant_id = $3`,
        [execution.movementId, params.documentId, params.tenantId]
      );

      if (!execution.created) {
        return buildReturnPostingReplayResult({
          config,
          tenantId: params.tenantId,
          documentId: params.documentId,
          movementId: execution.movementId,
          expectation: config.buildReplayExpectationFromPlan(postingPlan),
          client,
          fetchAggregateView: params.fetchAggregateView
        });
      }

      const posted = await params.fetchAggregateView(params.tenantId, params.documentId, client);
      if (!posted) {
        throw new Error(config.notFoundErrorCode);
      }

      return {
        responseBody: posted,
        responseStatus: 200,
        events: [buildMovementPostedEvent(execution.movementId)],
        projectionOps: [
          ...execution.projectionOps,
          ...config.buildPostProjectionOps({
            tenantId: params.tenantId,
            policy: postingPolicy
          })
        ]
      };
    }
  });
}
