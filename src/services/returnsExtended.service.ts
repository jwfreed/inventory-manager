import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { hashTransactionalIdempotencyRequest } from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import type {
  returnReceiptSchema,
  returnReceiptLineSchema,
  returnDispositionSchema,
  returnDispositionLineSchema,
} from '../schemas/returnsExtended.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { calculateMovementCost } from './costing.service';
import { createCostLayer } from './costLayers.service';
import { getCanonicalMovementFields } from './uomCanonical.service';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import { persistInventoryMovement } from '../domains/inventory';
import {
  runInventoryCommand,
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import {
  buildPostedDocumentReplayResult,
  buildInventoryBalanceProjectionOp,
  buildMovementPostedEvent,
  buildRefreshItemCostSummaryProjectionOp,
  buildReplayCorruptionError
} from '../modules/platform/application/inventoryMutationSupport';

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
  }
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
  }
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
  }
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
  }
}

function wrapPgError(error: unknown, messages: { entity: string }) {
  const mapped = mapPgErrorToHttp(error, {
    foreignKey: () => ({ status: 400, body: { error: `Referenced entity not found for ${messages.entity}.` } }),
    check: () => ({ status: 400, body: { error: `Invalid status or quantity for ${messages.entity}.` } }),
    unique: () => ({ status: 409, body: { error: `Duplicate constraint for ${messages.entity}.` } }),
  })
  if (mapped) {
    const err: any = new Error('PG error')
    err.http = mapped
    return err
  }
  return error
}

function normalizeOptionalIdempotencyKey(value?: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function returnReceiptPostIncompleteError(
  returnReceiptId: string,
  details?: Record<string, unknown>
) {
  const error = new Error('RETURN_RECEIPT_POST_INCOMPLETE') as Error & {
    code?: string
    details?: Record<string, unknown>
  }
  error.code = 'RETURN_RECEIPT_POST_INCOMPLETE'
  error.details = {
    returnReceiptId,
    hint: 'Return receipt status is inconsistent with authoritative movement state.',
    ...(details ?? {})
  }
  return error
}

async function buildReturnReceiptPostReplayResult(params: {
  tenantId: string
  returnReceiptId: string
  movementId: string
  expectedLineCount: number
  client: PoolClient
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount
      }
    ],
    client: params.client,
    fetchAggregateView: () => getReturnReceipt(params.tenantId, params.returnReceiptId, params.client),
    aggregateNotFoundError: new Error('RETURN_RECEIPT_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.movementId)
    ],
    responseStatus: 200
  })
}

export async function createReturnReceipt(tenantId: string, data: ReturnReceiptInput) {
  const now = new Date()
  const id = uuidv4()
  const status = data.status ?? 'draft'

  return withTransaction(async (client) => {
    let header
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
          status,
          data.receivedAt,
          data.receivedToLocationId,
          data.inventoryMovementId ?? null,
          data.externalRef ?? null,
          data.notes ?? null,
          now,
        ],
      )
    } catch (error) {
      throw wrapPgError(error, { entity: 'return receipt' })
    }

    let lines: any[] = []
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
          )
          lines.push(res.rows[0])
        } catch (error) {
          throw wrapPgError(error, { entity: 'return receipt line' })
        }
      }
    }

    return mapReturnReceipt(header.rows[0], lines)
  })
}

export async function listReturnReceipts(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM return_receipts
     WHERE tenant_id = $1
     ORDER BY received_at DESC, created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  )
  return rows.map((row) => mapReturnReceipt(row))
}

export async function getReturnReceipt(tenantId: string, id: string, client?: PoolClient) {
  const executor = client ? client.query.bind(client) : query
  const header = await executor('SELECT * FROM return_receipts WHERE id = $1 AND tenant_id = $2', [id, tenantId])
  if (header.rowCount === 0) return null
  const lines = await executor(
    'SELECT * FROM return_receipt_lines WHERE return_receipt_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
    [id, tenantId]
  )
  return mapReturnReceipt(header.rows[0], lines.rows)
}

export async function addReturnReceiptLine(
  tenantId: string,
  returnReceiptId: string,
  line: ReturnReceiptLineInput
) {
  const now = new Date()
  try {
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
    )
    return mapReturnReceiptLine(res.rows[0])
  } catch (error) {
    throw wrapPgError(error, { entity: 'return receipt line' })
  }
}

export async function postReturnReceipt(
  tenantId: string,
  id: string,
  params: {
    idempotencyKey: string
  }
) {
  const normalizedIdempotencyKey = normalizeOptionalIdempotencyKey(params.idempotencyKey)
  if (!normalizedIdempotencyKey) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED')
  }

  const requestHash = hashTransactionalIdempotencyRequest({
    method: 'POST',
    endpoint: IDEMPOTENCY_ENDPOINTS.RETURN_RECEIPTS_POST,
    body: { returnReceiptId: id }
  })

  let receipt: any = null
  let receiptLines: any[] = []
  let receiptWarehouseId: string | null = null

  return runInventoryCommand<any>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.RETURN_RECEIPTS_POST,
    operation: 'return_receipt_post',
    idempotencyKey: normalizedIdempotencyKey,
    requestHash,
    retryOptions: { isolationLevel: 'SERIALIZABLE', retries: 2 },
    onReplay: async ({ client, responseBody }) => {
      const replayMovementId = responseBody?.inventoryMovementId
      if (typeof replayMovementId !== 'string' || !replayMovementId) {
        throw buildReplayCorruptionError({
          tenantId,
          returnReceiptId: id,
          idempotencyKey: normalizedIdempotencyKey,
          reason: 'return_receipt_post_replay_movement_missing'
        })
      }
      return (
        await buildReturnReceiptPostReplayResult({
          tenantId,
          returnReceiptId: responseBody?.id ?? id,
          movementId: replayMovementId,
          expectedLineCount: Array.isArray(responseBody?.lines) ? responseBody.lines.length : 0,
          client
        })
      ).responseBody
    },
    lockTargets: async (client) => {
      const receiptResult = await client.query(
        `SELECT *
           FROM return_receipts
          WHERE id = $1
            AND tenant_id = $2
          FOR UPDATE`,
        [id, tenantId]
      )
      if (receiptResult.rowCount === 0) {
        throw new Error('RETURN_RECEIPT_NOT_FOUND')
      }
      const lockedReceipt = receiptResult.rows[0]
      receipt = lockedReceipt
      if (lockedReceipt.status === 'canceled') {
        throw new Error('RETURN_RECEIPT_CANCELED')
      }

      const linesResult = await client.query(
        `SELECT *
           FROM return_receipt_lines
          WHERE return_receipt_id = $1
            AND tenant_id = $2
          ORDER BY created_at ASC
          FOR UPDATE`,
        [id, tenantId]
      )
      if (linesResult.rowCount === 0) {
        throw new Error('RETURN_RECEIPT_NO_LINES')
      }
      receiptLines = linesResult.rows

      if (lockedReceipt.status === 'posted' && lockedReceipt.inventory_movement_id) {
        return []
      }
      if (lockedReceipt.status === 'posted' && !lockedReceipt.inventory_movement_id) {
        throw returnReceiptPostIncompleteError(id, {
          reason: 'return_receipt_posted_without_movement'
        })
      }
      if (!lockedReceipt.received_to_location_id) {
        throw new Error('RETURN_RECEIPT_LOCATION_REQUIRED')
      }

      receiptWarehouseId = await resolveWarehouseIdForLocation(
        tenantId,
        lockedReceipt.received_to_location_id,
        client
      )
      if (!receiptWarehouseId) {
        throw new Error('WAREHOUSE_SCOPE_REQUIRED')
      }
      const currentReceiptWarehouseId = receiptWarehouseId;

      const returnAuthResult = await client.query<{ status: string }>(
        `SELECT status
           FROM return_authorizations
          WHERE id = $1
            AND tenant_id = $2
          FOR UPDATE`,
        [lockedReceipt.return_authorization_id, tenantId]
      )
      if (returnAuthResult.rowCount === 0) {
        throw new Error('RETURN_AUTH_NOT_FOUND')
      }
      const returnAuthStatus = returnAuthResult.rows[0]?.status ?? 'draft'
      if (returnAuthStatus === 'canceled' || returnAuthStatus === 'closed') {
        throw new Error('RETURN_AUTH_NOT_POSTABLE')
      }

      const authLineIds = Array.from(
        new Set(
          receiptLines
            .map((line) => line.return_authorization_line_id)
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
        )
      ).sort((left, right) => left.localeCompare(right))
      if (authLineIds.length > 0) {
        const authLineResult = await client.query<{
          id: string
          item_id: string
          uom: string
          quantity_authorized: string | number
        }>(
          `SELECT id, item_id, uom, quantity_authorized
             FROM return_authorization_lines
            WHERE tenant_id = $1
              AND return_authorization_id = $2
              AND id = ANY($3::uuid[])
            ORDER BY id ASC
            FOR UPDATE`,
          [tenantId, lockedReceipt.return_authorization_id, authLineIds]
        )
        if (authLineResult.rowCount !== authLineIds.length) {
          throw new Error('RETURN_RECEIPT_LINE_INVALID_REFERENCE')
        }

        const postedTotalsResult = await client.query<{ line_id: string; qty: string | number }>(
          `SELECT rrl.return_authorization_line_id AS line_id,
                  COALESCE(SUM(rrl.quantity_received), 0)::numeric AS qty
             FROM return_receipt_lines rrl
             JOIN return_receipts rr
               ON rr.id = rrl.return_receipt_id
              AND rr.tenant_id = rrl.tenant_id
            WHERE rr.tenant_id = $1
              AND rr.return_authorization_id = $2
              AND rr.status = 'posted'
              AND rr.id <> $3
              AND rrl.return_authorization_line_id = ANY($4::uuid[])
            GROUP BY rrl.return_authorization_line_id`,
          [tenantId, lockedReceipt.return_authorization_id, id, authLineIds]
        )
        const authLineMap = new Map(authLineResult.rows.map((row) => [row.id, row]))
        const postedTotals = new Map(
          postedTotalsResult.rows.map((row) => [row.line_id, roundQuantity(toNumber(row.qty ?? 0))])
        )

        for (const line of receiptLines) {
          if (!line.return_authorization_line_id) {
            continue
          }
          const authLine = authLineMap.get(line.return_authorization_line_id)
          if (!authLine) {
            throw new Error('RETURN_RECEIPT_LINE_INVALID_REFERENCE')
          }
          if (authLine.item_id !== line.item_id || authLine.uom !== line.uom) {
            throw new Error('RETURN_RECEIPT_LINE_REFERENCE_MISMATCH')
          }
          const alreadyPosted = postedTotals.get(line.return_authorization_line_id) ?? 0
          const projectedTotal = roundQuantity(alreadyPosted + toNumber(line.quantity_received))
          const authorizedQty = roundQuantity(toNumber(authLine.quantity_authorized))
          if (projectedTotal - authorizedQty > 1e-6) {
            throw new Error('RETURN_RECEIPT_QTY_EXCEEDS_AUTHORIZED')
          }
        }
      }

      return Array.from(
        new Set(
          receiptLines
            .map((line) => line.item_id)
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
        )
      )
        .sort((left, right) => left.localeCompare(right))
        .map((itemId) => ({
          tenantId,
          warehouseId: receiptWarehouseId!,
          itemId
        }))
    },
    execute: async ({ client }) => {
      if (!receipt) {
        throw new Error('RETURN_RECEIPT_NOT_FOUND')
      }
      if (!receiptWarehouseId) {
        throw new Error('WAREHOUSE_SCOPE_REQUIRED')
      }
      const lockedReceipt = receipt;
      const lockedReceiptWarehouseId = receiptWarehouseId;

      if (lockedReceipt.status === 'posted') {
        if (!lockedReceipt.inventory_movement_id) {
          throw returnReceiptPostIncompleteError(id, {
            reason: 'return_receipt_posted_without_movement'
          })
        }
        return await buildReturnReceiptPostReplayResult({
          tenantId,
          returnReceiptId: id,
          movementId: lockedReceipt.inventory_movement_id,
          expectedLineCount: receiptLines.length,
          client
        })
      }

      const now = new Date()
      const occurredAt = lockedReceipt.received_at ? new Date(lockedReceipt.received_at) : now
      const projectionOps: InventoryCommandProjectionOp[] = []
      const itemsToRefresh = new Set<string>()
      if (!lockedReceipt.received_to_location_id) {
        throw new Error('RETURN_RECEIPT_LOCATION_REQUIRED')
      }
      const preparedLines: Array<{
        line: any
        canonicalFields: Awaited<ReturnType<typeof getCanonicalMovementFields>>
        costData: Awaited<ReturnType<typeof calculateMovementCost>>
      }> = []

      for (const line of receiptLines) {
        const canonicalFields = await getCanonicalMovementFields(
          tenantId,
          line.item_id,
          toNumber(line.quantity_received),
          line.uom,
          client
        )
        const costData = await calculateMovementCost(
          tenantId,
          line.item_id,
          canonicalFields.quantityDeltaCanonical,
          client
        )
        preparedLines.push({
          line,
          canonicalFields,
          costData
        })
      }

      const movement = await persistInventoryMovement(client, {
        id: uuidv4(),
        tenantId,
        movementType: 'receive',
        status: 'posted',
        externalRef: `return_receipt:${id}`,
        sourceType: 'return_receipt_post',
        sourceId: id,
        idempotencyKey: normalizedIdempotencyKey,
        occurredAt,
        postedAt: now,
        notes: lockedReceipt.notes ?? null,
        createdAt: now,
        updatedAt: now,
        lines: preparedLines.map((preparedLine) => ({
          warehouseId: lockedReceiptWarehouseId,
          sourceLineId: preparedLine.line.id,
          itemId: preparedLine.line.item_id,
          locationId: lockedReceipt.received_to_location_id,
          quantityDelta: preparedLine.canonicalFields.quantityDeltaCanonical,
          uom: preparedLine.canonicalFields.canonicalUom,
          quantityDeltaEntered: preparedLine.canonicalFields.quantityDeltaEntered,
          uomEntered: preparedLine.canonicalFields.uomEntered,
          quantityDeltaCanonical: preparedLine.canonicalFields.quantityDeltaCanonical,
          canonicalUom: preparedLine.canonicalFields.canonicalUom,
          uomDimension: preparedLine.canonicalFields.uomDimension,
          unitCost: preparedLine.costData.unitCost,
          extendedCost: preparedLine.costData.extendedCost,
          reasonCode: 'return_receipt',
          lineNotes: preparedLine.line.notes ?? `Return receipt ${id} line ${preparedLine.line.id}`,
          createdAt: now
        }))
      })

      if (!movement.created) {
        const lineCheck = await client.query(
          `SELECT 1
             FROM inventory_movement_lines
            WHERE tenant_id = $1
              AND movement_id = $2
            LIMIT 1`,
          [tenantId, movement.movementId]
        )
        if ((lineCheck.rowCount ?? 0) > 0) {
          await client.query(
            `UPDATE return_receipts
                SET status = 'posted',
                    inventory_movement_id = $1
              WHERE id = $2
                AND tenant_id = $3`,
            [movement.movementId, id, tenantId]
          )
          return await buildReturnReceiptPostReplayResult({
            tenantId,
            returnReceiptId: id,
            movementId: movement.movementId,
            expectedLineCount: preparedLines.length,
            client
          })
        }
        throw returnReceiptPostIncompleteError(id, {
          movementId: movement.movementId,
          reason: 'movement_exists_without_lines'
        })
      }

      for (const preparedLine of preparedLines) {
        await createCostLayer({
          tenant_id: tenantId,
          item_id: preparedLine.line.item_id,
          location_id: lockedReceipt.received_to_location_id,
          uom: preparedLine.canonicalFields.canonicalUom,
          quantity: preparedLine.canonicalFields.quantityDeltaCanonical,
          unit_cost: preparedLine.costData.unitCost ?? 0,
          source_type: 'receipt',
          source_document_id: preparedLine.line.id,
          movement_id: movement.movementId,
          layer_date: occurredAt,
          notes: `Return receipt ${id} line ${preparedLine.line.id}`,
          client
        })

        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: preparedLine.line.item_id,
            locationId: lockedReceipt.received_to_location_id,
            uom: preparedLine.canonicalFields.canonicalUom,
            deltaOnHand: preparedLine.canonicalFields.quantityDeltaCanonical
          })
        )
        itemsToRefresh.add(preparedLine.line.item_id)
      }

      for (const itemId of itemsToRefresh.values()) {
        projectionOps.push(buildRefreshItemCostSummaryProjectionOp(tenantId, itemId))
      }

      await client.query(
        `UPDATE return_receipts
            SET status = 'posted',
                inventory_movement_id = $1
          WHERE id = $2
            AND tenant_id = $3`,
        [movement.movementId, id, tenantId]
      )

      const posted = await getReturnReceipt(tenantId, id, client)
      if (!posted) {
        throw new Error('RETURN_RECEIPT_NOT_FOUND')
      }

      return {
        responseBody: posted,
        responseStatus: 200,
        events: [buildMovementPostedEvent(movement.movementId)],
        projectionOps
      }
    }
  })
}

export async function createReturnDisposition(tenantId: string, data: ReturnDispositionInput) {
  const now = new Date()
  const id = uuidv4()
  const status = data.status ?? 'draft'

  return withTransaction(async (client) => {
    let header
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
          status,
          data.occurredAt,
          data.dispositionType,
          data.fromLocationId,
          data.toLocationId ?? null,
          data.inventoryMovementId ?? null,
          data.notes ?? null,
          now,
        ],
      )
    } catch (error) {
      throw wrapPgError(error, { entity: 'return disposition' })
    }

    let lines: any[] = []
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
          )
          lines.push(res.rows[0])
        } catch (error) {
          throw wrapPgError(error, { entity: 'return disposition line' })
        }
      }
    }

    return mapReturnDisposition(header.rows[0], lines)
  })
}

export async function listReturnDispositions(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM return_dispositions
     WHERE tenant_id = $1
     ORDER BY occurred_at DESC, created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  )
  return rows.map((row) => mapReturnDisposition(row))
}

export async function getReturnDisposition(tenantId: string, id: string) {
  const header = await query('SELECT * FROM return_dispositions WHERE id = $1 AND tenant_id = $2', [id, tenantId])
  if (header.rowCount === 0) return null
  const lines = await query(
    'SELECT * FROM return_disposition_lines WHERE return_disposition_id = $1 AND tenant_id = $2 ORDER BY line_number ASC NULLS LAST',
    [id, tenantId],
  )
  return mapReturnDisposition(header.rows[0], lines.rows)
}

export async function addReturnDispositionLine(
  tenantId: string,
  returnDispositionId: string,
  line: ReturnDispositionLineInput,
) {
  const now = new Date()
  try {
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
    )
    return mapReturnDispositionLine(res.rows[0])
  } catch (error) {
    throw wrapPgError(error, { entity: 'return disposition line' })
  }
}
