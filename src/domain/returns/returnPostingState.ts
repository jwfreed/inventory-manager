import type { PoolClient } from 'pg';

export type ReturnPostingDocumentKind = 'receipt' | 'disposition';

export type ReturnPostingReplayState =
  | 'DRAFT_UNPOSTED'
  | 'VALID_COMPLETE'
  | 'RECOVERABLE_PARTIAL'
  | 'TOLERATED_DRIFT'
  | 'IRRECOVERABLE';

type ReturnDocumentRow = {
  id: string;
  status: string;
  inventory_movement_id: string | null;
};

type SourceBackedMovementRow = {
  id: string;
  movement_type: string;
  status: string;
  source_type: string | null;
  source_id: string | null;
  line_count: string | number;
};

export type ReturnPostingStateClassification = Readonly<{
  state: ReturnPostingReplayState;
  documentId: string;
  documentStatus: string | null;
  inventoryMovementId: string | null;
  authoritativeMovementId: string | null;
  reason: string | null;
  details: Record<string, unknown>;
}>;

type ReturnPostingDocumentConfig = Readonly<{
  tableName: 'return_receipts' | 'return_dispositions';
  sourceType: 'return_receipt_post' | 'return_disposition_post';
  expectedMovementType: 'receive' | 'transfer';
}>;

const RETURN_POSTING_CONFIG: Record<ReturnPostingDocumentKind, ReturnPostingDocumentConfig> = Object.freeze({
  receipt: Object.freeze({
    tableName: 'return_receipts',
    sourceType: 'return_receipt_post',
    expectedMovementType: 'receive'
  }),
  disposition: Object.freeze({
    tableName: 'return_dispositions',
    sourceType: 'return_disposition_post',
    expectedMovementType: 'transfer'
  })
});

function buildClassification(params: {
  state: ReturnPostingReplayState;
  documentId: string;
  documentStatus?: string | null;
  inventoryMovementId?: string | null;
  authoritativeMovementId?: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}): ReturnPostingStateClassification {
  return Object.freeze({
    state: params.state,
    documentId: params.documentId,
    documentStatus: params.documentStatus ?? null,
    inventoryMovementId: params.inventoryMovementId ?? null,
    authoritativeMovementId: params.authoritativeMovementId ?? null,
    reason: params.reason ?? null,
    details: params.details ?? {}
  });
}

async function loadReturnDocumentRow(params: {
  client: PoolClient;
  tenantId: string;
  documentId: string;
  config: ReturnPostingDocumentConfig;
}) {
  const result = await params.client.query<ReturnDocumentRow>(
    `SELECT id, status, inventory_movement_id
       FROM ${params.config.tableName}
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1
      FOR UPDATE`,
    [params.tenantId, params.documentId]
  );
  return result.rows[0] ?? null;
}

async function loadSourceBackedMovements(params: {
  client: PoolClient;
  tenantId: string;
  documentId: string;
  config: ReturnPostingDocumentConfig;
}) {
  const result = await params.client.query<SourceBackedMovementRow>(
    `SELECT im.id,
            im.movement_type,
            im.status,
            im.source_type,
            im.source_id,
            (
              SELECT COUNT(*)::int
                FROM inventory_movement_lines iml
               WHERE iml.tenant_id = im.tenant_id
                 AND iml.movement_id = im.id
            ) AS line_count
       FROM inventory_movements im
      WHERE im.tenant_id = $1
        AND im.source_type = $2
        AND im.source_id = $3
      FOR UPDATE`,
    [params.tenantId, params.config.sourceType, params.documentId]
  );
  return result.rows;
}

function movementReadyDetails(
  row: SourceBackedMovementRow,
  expectedMovementType: 'receive' | 'transfer'
) {
  const lineCount = Number(row.line_count ?? 0);
  if (row.status !== 'posted') {
    return {
      ready: false,
      reason: 'source_backed_movement_not_posted',
      details: {
        movementId: row.id,
        movementStatus: row.status
      }
    };
  }
  if (row.movement_type !== expectedMovementType) {
    return {
      ready: false,
      reason: 'source_backed_movement_type_invalid',
      details: {
        movementId: row.id,
        movementType: row.movement_type,
        expectedMovementType
      }
    };
  }
  if (lineCount <= 0) {
    return {
      ready: false,
      reason: 'source_backed_movement_lines_missing',
      details: {
        movementId: row.id,
        lineCount
      }
    };
  }
  return { ready: true, reason: null, details: {} };
}

export async function classifyReturnPostingState(params: {
  client: PoolClient;
  tenantId: string;
  documentId: string;
  kind: ReturnPostingDocumentKind;
  expectedMovementId?: string | null;
}) {
  const config = RETURN_POSTING_CONFIG[params.kind];
  const documentRow = await loadReturnDocumentRow({
    client: params.client,
    tenantId: params.tenantId,
    documentId: params.documentId,
    config
  });

  if (!documentRow) {
    return buildClassification({
      state: 'IRRECOVERABLE',
      documentId: params.documentId,
      reason: 'return_document_missing',
      details: {
        kind: params.kind
      }
    });
  }

  const sourceBackedMovements = await loadSourceBackedMovements({
    client: params.client,
    tenantId: params.tenantId,
    documentId: params.documentId,
    config
  });

  if (sourceBackedMovements.length > 1) {
    return buildClassification({
      state: 'IRRECOVERABLE',
      documentId: documentRow.id,
      documentStatus: documentRow.status,
      inventoryMovementId: documentRow.inventory_movement_id,
      reason: 'source_backed_movement_ambiguous',
      details: {
        movementIds: sourceBackedMovements.map((row) => row.id)
      }
    });
  }

  const authoritativeMovement = sourceBackedMovements[0] ?? null;
  if (!authoritativeMovement) {
    if (documentRow.status === 'posted' || documentRow.inventory_movement_id) {
      return buildClassification({
        state: 'IRRECOVERABLE',
        documentId: documentRow.id,
        documentStatus: documentRow.status,
        inventoryMovementId: documentRow.inventory_movement_id,
        reason: 'posted_without_authoritative_movement'
      });
    }
    return buildClassification({
      state: 'DRAFT_UNPOSTED',
      documentId: documentRow.id,
      documentStatus: documentRow.status,
      inventoryMovementId: documentRow.inventory_movement_id
    });
  }

  const ready = movementReadyDetails(authoritativeMovement, config.expectedMovementType);
  if (!ready.ready) {
    return buildClassification({
      state: 'IRRECOVERABLE',
      documentId: documentRow.id,
      documentStatus: documentRow.status,
      inventoryMovementId: documentRow.inventory_movement_id,
      authoritativeMovementId: authoritativeMovement.id,
      reason: ready.reason,
      details: ready.details
    });
  }

  if (
    params.expectedMovementId
    && params.expectedMovementId !== authoritativeMovement.id
  ) {
    return buildClassification({
      state: 'IRRECOVERABLE',
      documentId: documentRow.id,
      documentStatus: documentRow.status,
      inventoryMovementId: documentRow.inventory_movement_id,
      authoritativeMovementId: authoritativeMovement.id,
      reason: 'idempotent_response_movement_mismatch',
      details: {
        expectedMovementId: params.expectedMovementId,
        authoritativeMovementId: authoritativeMovement.id
      }
    });
  }

  if (
    documentRow.inventory_movement_id
    && documentRow.inventory_movement_id !== authoritativeMovement.id
  ) {
    return buildClassification({
      state: 'TOLERATED_DRIFT',
      documentId: documentRow.id,
      documentStatus: documentRow.status,
      inventoryMovementId: documentRow.inventory_movement_id,
      authoritativeMovementId: authoritativeMovement.id,
      reason: 'linked_movement_mismatch'
    });
  }

  if (documentRow.status === 'posted' && documentRow.inventory_movement_id === authoritativeMovement.id) {
    return buildClassification({
      state: 'VALID_COMPLETE',
      documentId: documentRow.id,
      documentStatus: documentRow.status,
      inventoryMovementId: documentRow.inventory_movement_id,
      authoritativeMovementId: authoritativeMovement.id
    });
  }

  return buildClassification({
    state: 'RECOVERABLE_PARTIAL',
    documentId: documentRow.id,
    documentStatus: documentRow.status,
    inventoryMovementId: documentRow.inventory_movement_id,
    authoritativeMovementId: authoritativeMovement.id,
    reason: 'aggregate_link_missing_or_stale'
  });
}

export async function repairReturnPostingAggregateState(params: {
  client: PoolClient;
  tenantId: string;
  documentId: string;
  kind: ReturnPostingDocumentKind;
  movementId: string;
}) {
  const config = RETURN_POSTING_CONFIG[params.kind];
  await params.client.query(
    `UPDATE ${config.tableName}
        SET status = 'posted',
            inventory_movement_id = $1
      WHERE tenant_id = $2
        AND id = $3`,
    [params.movementId, params.tenantId, params.documentId]
  );
}
