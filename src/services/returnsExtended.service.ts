import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import type {
  returnReceiptSchema,
  returnReceiptLineSchema,
  returnDispositionSchema,
  returnDispositionLineSchema,
} from '../schemas/returnsExtended.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';

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
  return rows.map(mapReturnReceipt)
}

export async function getReturnReceipt(tenantId: string, id: string) {
  const header = await query('SELECT * FROM return_receipts WHERE id = $1 AND tenant_id = $2', [id, tenantId])
  if (header.rowCount === 0) return null
  const lines = await query(
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
  return rows.map(mapReturnDisposition)
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
