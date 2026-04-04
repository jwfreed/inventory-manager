import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { hashTransactionalIdempotencyRequest } from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import type {
  returnReceiptSchema,
  returnReceiptLineSchema,
  returnDispositionSchema,
  returnDispositionLineSchema,
} from '../schemas/returnsExtended.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
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
  repairReturnPostingAggregateState
} from '../domain/returns/returnPostingState';

export type ReturnReceiptInput = z.infer<typeof returnReceiptSchema>;
export type ReturnReceiptLineInput = z.infer<typeof returnReceiptLineSchema>;
export type ReturnDispositionInput = z.infer<typeof returnDispositionSchema>;
export type ReturnDispositionLineInput = z.infer<typeof returnDispositionLineSchema>;

export function mapReturnReceipt(row: any, lines?: any[]) {
  return {
    id: row.id,
    returnAuthorizationId: row.return_authorization_id,
    status: row.status,
    receivedAt: row.received_at,
    receivedToLocationId: row.received_to_location_id,
    inventoryMovementId: row.inventory_movement_id,
    externalRef: row.external_ref,
    notes: row.notes,
    createdAt: row.created_at,
    lines: lines?.map(mapReturnReceiptLine),
  };
}

export function mapReturnReceiptLine(row: any) {
  return {
    id: row.id,
    returnReceiptId: row.return_receipt_id,
    returnAuthorizationLineId: row.return_authorization_line_id,
    itemId: row.item_id,
    uom: row.uom,
    quantityReceived: Number(row.quantity_received),
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export function mapReturnDisposition(row: any, lines?: any[]) {
  return {
    id: row.id,
    returnReceiptId: row.return_receipt_id,
    status: row.status,
    occurredAt: row.occurred_at,
    dispositionType: row.disposition_type,
    fromLocationId: row.from_location_id,
    toLocationId: row.to_location_id,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    createdAt: row.created_at,
    lines: lines?.map(mapReturnDispositionLine),
  };
}

export function mapReturnDispositionLine(row: any) {
  return {
    id: row.id,
    returnDispositionId: row.return_disposition_id,
    lineNumber: row.line_number,
    itemId: row.item_id,
    uom: row.uom,
    quantity: Number(row.quantity),
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function wrapPgError(error: unknown, messages: { entity: string }) {
  const mapped = mapPgErrorToHttp(error, {
    foreignKey: () => ({ status: 400, body: { error: `Referenced entity not found for ${messages.entity}.` } }),
    check: () => ({ status: 400, body: { error: `Invalid status or quantity for ${messages.entity}.` } }),
    unique: () => ({ status: 409, body: { error: `Duplicate constraint for ${messages.entity}.` } }),
  });
  if (mapped) {
    const err: any = new Error('PG error');
    err.http = mapped;
    return err;
  }
  return error;
}

function normalizeOptionalIdempotencyKey(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function assertReturnDocumentEditable(params: {
  tenantId: string;
  documentId: string;
  table: 'return_receipts' | 'return_dispositions';
  client?: PoolClient;
}) {
  const executor = params.client ? params.client.query.bind(params.client) : query;
  const result = await executor(
    `SELECT status
       FROM ${params.table}
      WHERE id = $1
        AND tenant_id = $2`,
    [params.documentId, params.tenantId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(params.table === 'return_receipts' ? 'RETURN_RECEIPT_NOT_FOUND' : 'RETURN_DISPOSITION_NOT_FOUND');
  }
  if (result.rows[0]?.status !== 'draft') {
    throw new Error(params.table === 'return_receipts' ? 'RETURN_RECEIPT_NOT_EDITABLE' : 'RETURN_DISPOSITION_NOT_EDITABLE');
  }
}

function isReturnReplayableState(
  state: Awaited<ReturnType<typeof classifyReturnPostingState>>['state']
) {
  return (
    state === 'VALID_COMPLETE'
    || state === 'RECOVERABLE_PARTIAL'
    || state === 'TOLERATED_DRIFT'
  );
}

function buildReturnRecoveryIrrecoverableError(params: {
  code: 'RETURN_RECEIPT_RECOVERY_IRRECOVERABLE' | 'RETURN_DISPOSITION_RECOVERY_IRRECOVERABLE';
  documentId: string;
  classification: {
    state: string;
    reason: string | null;
    details: Record<string, unknown>;
    authoritativeMovementId: string | null;
    inventoryMovementId: string | null;
    documentStatus: string | null;
  };
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

async function buildReturnReceiptPostReplayResult(params: {
  tenantId: string;
  returnReceiptId: string;
  movementId: string;
  expectedLineCount: number;
  expectedDeterministicHash?: string | null;
  client: PoolClient;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      buildReplayDeterminismExpectation({
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount,
        expectedDeterministicHash: params.expectedDeterministicHash ?? null
      })
    ],
    client: params.client,
    preFetchIntegrityCheck: async () => {
      await repairReturnPostingAggregateState({
        client: params.client,
        tenantId: params.tenantId,
        documentId: params.returnReceiptId,
        kind: 'receipt',
        movementId: params.movementId
      });
    },
    fetchAggregateView: () => getReturnReceipt(params.tenantId, params.returnReceiptId, params.client),
    aggregateNotFoundError: new Error('RETURN_RECEIPT_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.movementId)
    ],
    responseStatus: 200
  });
}

async function buildReturnDispositionPostReplayResult(params: {
  tenantId: string;
  returnDispositionId: string;
  movementId: string;
  expectedLineCount: number;
  expectedDeterministicHash?: string | null;
  client: PoolClient;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      buildReplayDeterminismExpectation({
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount,
        expectedDeterministicHash: params.expectedDeterministicHash ?? null
      })
    ],
    client: params.client,
    preFetchIntegrityCheck: async () => {
      await repairReturnPostingAggregateState({
        client: params.client,
        tenantId: params.tenantId,
        documentId: params.returnDispositionId,
        kind: 'disposition',
        movementId: params.movementId
      });
    },
    fetchAggregateView: () => getReturnDisposition(params.tenantId, params.returnDispositionId, params.client),
    aggregateNotFoundError: new Error('RETURN_DISPOSITION_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.movementId)
    ],
    responseStatus: 200
  });
}

export async function createReturnReceipt(tenantId: string, data: ReturnReceiptInput) {
  const now = new Date();
  const id = uuidv4();

  return withTransaction(async (client) => {
    let header;
    try {
      header = await client.query(
        `INSERT INTO return_receipts (
          id, tenant_id, return_authorization_id, status, received_at, received_to_location_id,
          inventory_movement_id, external_ref, notes, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *`,
        [
          id,
          tenantId,
          data.returnAuthorizationId,
          'draft',
          data.receivedAt,
          data.receivedToLocationId,
          null,
          data.externalRef ?? null,
          data.notes ?? null,
          now,
        ],
      );
    } catch (error) {
      throw wrapPgError(error, { entity: 'return receipt' });
    }

    const lines: any[] = [];
    if (data.lines && data.lines.length) {
      for (const line of data.lines) {
        try {
          const res = await client.query(
            `INSERT INTO return_receipt_lines (
              id, tenant_id, return_receipt_id, return_authorization_line_id, item_id, uom, quantity_received, notes, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING *`,
            [
              uuidv4(),
              tenantId,
              id,
              line.returnAuthorizationLineId ?? null,
              line.itemId,
              line.uom,
              line.quantityReceived,
              line.notes ?? null,
              now,
            ],
          );
          lines.push(res.rows[0]);
        } catch (error) {
          throw wrapPgError(error, { entity: 'return receipt line' });
        }
      }
    }

    return mapReturnReceipt(header.rows[0], lines);
  });
}

export async function listReturnReceipts(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM return_receipts
     WHERE tenant_id = $1
     ORDER BY received_at DESC, created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows.map((row) => mapReturnReceipt(row));
}

export async function getReturnReceipt(tenantId: string, id: string, client?: PoolClient) {
  const executor = client ? client.query.bind(client) : query;
  const header = await executor('SELECT * FROM return_receipts WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (header.rowCount === 0) return null;
  const lines = await executor(
    'SELECT * FROM return_receipt_lines WHERE return_receipt_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
    [id, tenantId]
  );
  return mapReturnReceipt(header.rows[0], lines.rows);
}

export async function addReturnReceiptLine(
  tenantId: string,
  returnReceiptId: string,
  line: ReturnReceiptLineInput
) {
  const now = new Date();
  try {
    await assertReturnDocumentEditable({
      tenantId,
      documentId: returnReceiptId,
      table: 'return_receipts'
    });
    const res = await query(
      `INSERT INTO return_receipt_lines (
        id, tenant_id, return_receipt_id, return_authorization_line_id, item_id, uom, quantity_received, notes, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        uuidv4(),
        tenantId,
        returnReceiptId,
        line.returnAuthorizationLineId ?? null,
        line.itemId,
        line.uom,
        line.quantityReceived,
        line.notes ?? null,
        now,
      ],
    );
    return mapReturnReceiptLine(res.rows[0]);
  } catch (error) {
    throw wrapPgError(error, { entity: 'return receipt line' });
  }
}

export async function postReturnReceipt(
  tenantId: string,
  id: string,
  params: { idempotencyKey: string }
) {
  const normalizedIdempotencyKey = normalizeOptionalIdempotencyKey(params.idempotencyKey);
  if (!normalizedIdempotencyKey) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }

  const requestHash = hashTransactionalIdempotencyRequest({
    method: 'POST',
    endpoint: IDEMPOTENCY_ENDPOINTS.RETURN_RECEIPTS_POST,
    body: { returnReceiptId: id }
  });

  let receipt: any = null;
  let receiptLines: any[] = [];
  let receiptClassification: Awaited<ReturnType<typeof classifyReturnPostingState>> | null = null;
  let receiptPolicy: Awaited<ReturnType<typeof evaluateReturnReceiptPostPolicy>> | null = null;
  let receiptPlan: Awaited<ReturnType<typeof buildReturnReceiptMovementPlan>> | null = null;

  return runInventoryCommand<any>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.RETURN_RECEIPTS_POST,
    operation: 'return_receipt_post',
    idempotencyKey: normalizedIdempotencyKey,
    requestHash,
    retryOptions: { isolationLevel: 'SERIALIZABLE', retries: 2 },
    onReplay: async ({ client, responseBody }) => {
      const replayMovementId = responseBody?.inventoryMovementId;
      if (typeof replayMovementId !== 'string' || !replayMovementId) {
        throw buildReplayCorruptionError({
          tenantId,
          returnReceiptId: id,
          idempotencyKey: normalizedIdempotencyKey,
          reason: 'return_receipt_post_replay_movement_missing'
        });
      }
      const replayClassification = await classifyReturnPostingState({
        client,
        tenantId,
        documentId: id,
        kind: 'receipt',
        expectedMovementId: replayMovementId
      });
      if (!isReturnReplayableState(replayClassification.state) || !replayClassification.authoritativeMovementId) {
        throw buildReturnRecoveryIrrecoverableError({
          code: 'RETURN_RECEIPT_RECOVERY_IRRECOVERABLE',
          documentId: id,
          classification: replayClassification
        });
      }
      return (
        await buildReturnReceiptPostReplayResult({
          tenantId,
          returnReceiptId: responseBody?.id ?? id,
          movementId: replayClassification.authoritativeMovementId,
          expectedLineCount: Array.isArray(responseBody?.lines) ? responseBody.lines.length : 0,
          client
        })
      ).responseBody;
    },
    lockTargets: async (client) => {
      const receiptResult = await client.query(
        `SELECT *
           FROM return_receipts
          WHERE id = $1
            AND tenant_id = $2
          FOR UPDATE`,
        [id, tenantId]
      );
      if (receiptResult.rowCount === 0) {
        throw new Error('RETURN_RECEIPT_NOT_FOUND');
      }
      receipt = receiptResult.rows[0];
      if (receipt.status === 'canceled') {
        throw new Error('RETURN_RECEIPT_CANCELED');
      }

      const linesResult = await client.query(
        `SELECT *
           FROM return_receipt_lines
          WHERE return_receipt_id = $1
            AND tenant_id = $2
          ORDER BY created_at ASC
          FOR UPDATE`,
        [id, tenantId]
      );
      if (linesResult.rowCount === 0) {
        throw new Error('RETURN_RECEIPT_NO_LINES');
      }
      receiptLines = linesResult.rows;

      receiptClassification = await classifyReturnPostingState({
        client,
        tenantId,
        documentId: id,
        kind: 'receipt'
      });
      if (receiptClassification.state === 'IRRECOVERABLE') {
        throw buildReturnRecoveryIrrecoverableError({
          code: 'RETURN_RECEIPT_RECOVERY_IRRECOVERABLE',
          documentId: id,
          classification: receiptClassification
        });
      }
      if (isReturnReplayableState(receiptClassification.state)) {
        return [];
      }

      receiptPolicy = await evaluateReturnReceiptPostPolicy({
        client,
        tenantId,
        receipt,
        receiptLines
      });
      receiptPlan = await buildReturnReceiptMovementPlan({
        client,
        tenantId,
        receipt,
        receiptLines,
        policy: receiptPolicy,
        idempotencyKey: normalizedIdempotencyKey
      });
      return receiptPolicy.itemIdsToLock.map((itemId) => ({
        tenantId,
        warehouseId: receiptPolicy!.warehouseId,
        itemId
      }));
    },
    execute: async ({ client }) => {
      if (
        receiptClassification
        && isReturnReplayableState(receiptClassification.state)
        && receiptClassification.authoritativeMovementId
      ) {
        return await buildReturnReceiptPostReplayResult({
          tenantId,
          returnReceiptId: id,
          movementId: receiptClassification.authoritativeMovementId,
          expectedLineCount: receiptLines.length,
          client
        });
      }
      if (!receiptPolicy || !receiptPlan) {
        throw new Error('RETURN_RECEIPT_POLICY_REQUIRED');
      }

      const execution = await executeReturnReceiptMovementPlan({
        client,
        tenantId,
        receiptId: id,
        plan: receiptPlan,
        occurredAt: receiptPolicy.occurredAt
      });

      await client.query(
        `UPDATE return_receipts
            SET status = 'posted',
                inventory_movement_id = $1
          WHERE id = $2
            AND tenant_id = $3`,
        [execution.movementId, id, tenantId]
      );

      if (!execution.created) {
        return await buildReturnReceiptPostReplayResult({
          tenantId,
          returnReceiptId: id,
          movementId: execution.movementId,
          expectedLineCount: receiptPlan.movement.expectedLineCount,
          expectedDeterministicHash: receiptPlan.movement.expectedDeterministicHash,
          client
        });
      }

      const posted = await getReturnReceipt(tenantId, id, client);
      if (!posted) {
        throw new Error('RETURN_RECEIPT_NOT_FOUND');
      }

      return {
        responseBody: posted,
        responseStatus: 200,
        events: [buildMovementPostedEvent(execution.movementId)],
        projectionOps: [
          ...execution.projectionOps,
          ...receiptPolicy.itemIdsToLock.map((itemId) => buildRefreshItemCostSummaryProjectionOp(tenantId, itemId))
        ]
      };
    }
  });
}

export async function createReturnDisposition(tenantId: string, data: ReturnDispositionInput) {
  const now = new Date();
  const id = uuidv4();

  return withTransaction(async (client) => {
    let header;
    try {
      header = await client.query(
        `INSERT INTO return_dispositions (
          id, tenant_id, return_receipt_id, status, occurred_at, disposition_type, from_location_id, to_location_id,
          inventory_movement_id, notes, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *`,
        [
          id,
          tenantId,
          data.returnReceiptId,
          'draft',
          data.occurredAt,
          data.dispositionType,
          data.fromLocationId,
          data.toLocationId ?? null,
          null,
          data.notes ?? null,
          now,
        ],
      );
    } catch (error) {
      throw wrapPgError(error, { entity: 'return disposition' });
    }

    const lines: any[] = [];
    if (data.lines && data.lines.length) {
      for (const line of data.lines) {
        try {
          const res = await client.query(
            `INSERT INTO return_disposition_lines (
              id, tenant_id, return_disposition_id, line_number, item_id, uom, quantity, notes, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING *`,
            [
              uuidv4(),
              tenantId,
              id,
              line.lineNumber ?? null,
              line.itemId,
              line.uom,
              line.quantity,
              line.notes ?? null,
              now,
            ],
          );
          lines.push(res.rows[0]);
        } catch (error) {
          throw wrapPgError(error, { entity: 'return disposition line' });
        }
      }
    }

    return mapReturnDisposition(header.rows[0], lines);
  });
}

export async function listReturnDispositions(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM return_dispositions
     WHERE tenant_id = $1
     ORDER BY occurred_at DESC, created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows.map((row) => mapReturnDisposition(row));
}

export async function getReturnDisposition(tenantId: string, id: string, client?: PoolClient) {
  const executor = client ? client.query.bind(client) : query;
  const header = await executor('SELECT * FROM return_dispositions WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (header.rowCount === 0) return null;
  const lines = await executor(
    'SELECT * FROM return_disposition_lines WHERE return_disposition_id = $1 AND tenant_id = $2 ORDER BY line_number ASC NULLS LAST, created_at ASC',
    [id, tenantId],
  );
  return mapReturnDisposition(header.rows[0], lines.rows);
}

export async function addReturnDispositionLine(
  tenantId: string,
  returnDispositionId: string,
  line: ReturnDispositionLineInput,
) {
  const now = new Date();
  try {
    await assertReturnDocumentEditable({
      tenantId,
      documentId: returnDispositionId,
      table: 'return_dispositions'
    });
    const res = await query(
      `INSERT INTO return_disposition_lines (
        id, tenant_id, return_disposition_id, line_number, item_id, uom, quantity, notes, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        uuidv4(),
        tenantId,
        returnDispositionId,
        line.lineNumber ?? null,
        line.itemId,
        line.uom,
        line.quantity,
        line.notes ?? null,
        now,
      ],
    );
    return mapReturnDispositionLine(res.rows[0]);
  } catch (error) {
    throw wrapPgError(error, { entity: 'return disposition line' });
  }
}

export async function postReturnDisposition(
  tenantId: string,
  id: string,
  params: { idempotencyKey: string }
) {
  const normalizedIdempotencyKey = normalizeOptionalIdempotencyKey(params.idempotencyKey);
  if (!normalizedIdempotencyKey) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }

  const requestHash = hashTransactionalIdempotencyRequest({
    method: 'POST',
    endpoint: IDEMPOTENCY_ENDPOINTS.RETURN_DISPOSITIONS_POST,
    body: { returnDispositionId: id }
  });

  let disposition: any = null;
  let dispositionLines: any[] = [];
  let dispositionClassification: Awaited<ReturnType<typeof classifyReturnPostingState>> | null = null;
  let dispositionPolicy: Awaited<ReturnType<typeof evaluateReturnDispositionPostPolicy>> | null = null;
  let dispositionPlan: Awaited<ReturnType<typeof buildReturnDispositionMovementPlan>> | null = null;

  return runInventoryCommand<any>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.RETURN_DISPOSITIONS_POST,
    operation: 'return_disposition_post',
    idempotencyKey: normalizedIdempotencyKey,
    requestHash,
    retryOptions: { isolationLevel: 'SERIALIZABLE', retries: 2 },
    onReplay: async ({ client, responseBody }) => {
      const replayMovementId = responseBody?.inventoryMovementId;
      if (typeof replayMovementId !== 'string' || !replayMovementId) {
        throw buildReplayCorruptionError({
          tenantId,
          returnDispositionId: id,
          idempotencyKey: normalizedIdempotencyKey,
          reason: 'return_disposition_post_replay_movement_missing'
        });
      }
      const replayClassification = await classifyReturnPostingState({
        client,
        tenantId,
        documentId: id,
        kind: 'disposition',
        expectedMovementId: replayMovementId
      });
      if (!isReturnReplayableState(replayClassification.state) || !replayClassification.authoritativeMovementId) {
        throw buildReturnRecoveryIrrecoverableError({
          code: 'RETURN_DISPOSITION_RECOVERY_IRRECOVERABLE',
          documentId: id,
          classification: replayClassification
        });
      }
      return (
        await buildReturnDispositionPostReplayResult({
          tenantId,
          returnDispositionId: responseBody?.id ?? id,
          movementId: replayClassification.authoritativeMovementId,
          expectedLineCount: Array.isArray(responseBody?.lines) ? responseBody.lines.length * 2 : 0,
          client
        })
      ).responseBody;
    },
    lockTargets: async (client) => {
      const dispositionResult = await client.query(
        `SELECT *
           FROM return_dispositions
          WHERE id = $1
            AND tenant_id = $2
          FOR UPDATE`,
        [id, tenantId]
      );
      if (dispositionResult.rowCount === 0) {
        throw new Error('RETURN_DISPOSITION_NOT_FOUND');
      }
      disposition = dispositionResult.rows[0];
      if (disposition.status === 'canceled') {
        throw new Error('RETURN_DISPOSITION_CANCELED');
      }

      const linesResult = await client.query(
        `SELECT *
           FROM return_disposition_lines
          WHERE return_disposition_id = $1
            AND tenant_id = $2
          ORDER BY line_number ASC NULLS LAST, created_at ASC
          FOR UPDATE`,
        [id, tenantId]
      );
      if (linesResult.rowCount === 0) {
        throw new Error('RETURN_DISPOSITION_NO_LINES');
      }
      dispositionLines = linesResult.rows;

      dispositionClassification = await classifyReturnPostingState({
        client,
        tenantId,
        documentId: id,
        kind: 'disposition'
      });
      if (dispositionClassification.state === 'IRRECOVERABLE') {
        throw buildReturnRecoveryIrrecoverableError({
          code: 'RETURN_DISPOSITION_RECOVERY_IRRECOVERABLE',
          documentId: id,
          classification: dispositionClassification
        });
      }
      if (isReturnReplayableState(dispositionClassification.state)) {
        return [];
      }

      dispositionPolicy = await evaluateReturnDispositionPostPolicy({
        client,
        tenantId,
        disposition,
        dispositionLines
      });
      dispositionPlan = await buildReturnDispositionMovementPlan({
        client,
        tenantId,
        disposition,
        dispositionLines,
        policy: dispositionPolicy,
        idempotencyKey: normalizedIdempotencyKey
      });
      return dispositionPolicy.itemIdsToLock.map((itemId) => ({
        tenantId,
        warehouseId: dispositionPolicy!.warehouseId,
        itemId
      }));
    },
    execute: async ({ client }) => {
      if (
        dispositionClassification
        && isReturnReplayableState(dispositionClassification.state)
        && dispositionClassification.authoritativeMovementId
      ) {
        return await buildReturnDispositionPostReplayResult({
          tenantId,
          returnDispositionId: id,
          movementId: dispositionClassification.authoritativeMovementId,
          expectedLineCount: dispositionLines.length * 2,
          client
        });
      }
      if (!dispositionPolicy || !dispositionPlan) {
        throw new Error('RETURN_DISPOSITION_POLICY_REQUIRED');
      }

      const execution = await executeReturnDispositionMovementPlan({
        client,
        tenantId,
        dispositionId: id,
        plan: dispositionPlan,
        occurredAt: dispositionPolicy.occurredAt
      });

      await repairReturnPostingAggregateState({
        client,
        tenantId,
        documentId: id,
        kind: 'disposition',
        movementId: execution.movementId
      });

      if (!execution.created) {
        return await buildReturnDispositionPostReplayResult({
          tenantId,
          returnDispositionId: id,
          movementId: execution.movementId,
          expectedLineCount: dispositionPlan.movement.expectedLineCount,
          expectedDeterministicHash: dispositionPlan.movement.expectedDeterministicHash,
          client
        });
      }

      const posted = await getReturnDisposition(tenantId, id, client);
      if (!posted) {
        throw new Error('RETURN_DISPOSITION_NOT_FOUND');
      }

      return {
        responseBody: posted,
        responseStatus: 200,
        events: [buildMovementPostedEvent(execution.movementId)],
        projectionOps: [...execution.projectionOps]
      };
    }
  });
}
