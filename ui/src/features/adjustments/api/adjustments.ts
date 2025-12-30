import { apiDelete, apiGet, apiPost, apiPut } from '../../../api/http'
import type {
  InventoryAdjustment,
  InventoryAdjustmentLine,
  InventoryAdjustmentListResponse,
  InventoryAdjustmentSummary,
} from '../../../api/types'

export type AdjustmentListParams = {
  status?: string
  occurredFrom?: string
  occurredTo?: string
  itemId?: string
  locationId?: string
  limit?: number
  offset?: number
}

export type AdjustmentLinePayload = {
  lineNumber?: number
  itemId: string
  locationId: string
  uom: string
  quantityDelta: number
  reasonCode: string
  notes?: string
}

export type AdjustmentPayload = {
  occurredAt: string
  correctedFromAdjustmentId?: string
  notes?: string
  lines: AdjustmentLinePayload[]
}

type AdjustmentApiRow = Partial<InventoryAdjustment> & {
  occurred_at?: string
  inventory_movement_id?: string | null
  corrected_from_adjustment_id?: string | null
  is_corrected?: boolean
  created_at?: string
  updated_at?: string
  lines?: AdjustmentLineApiRow[]
}

type AdjustmentLineApiRow = Partial<InventoryAdjustmentLine> & {
  line_number?: number
  item_id?: string
  item_sku?: string | null
  item_name?: string | null
  location_id?: string
  location_code?: string | null
  location_name?: string | null
  quantity_delta?: number | string
  reason_code?: string
  created_at?: string
}

type AdjustmentSummaryApiRow = Partial<InventoryAdjustmentSummary> & {
  occurred_at?: string
  inventory_movement_id?: string | null
  corrected_from_adjustment_id?: string | null
  is_corrected?: boolean
  line_count?: number
  totals_by_uom?: Array<{ uom: string; quantityDelta?: number; quantity_delta?: number }>
  totalsByUom?: Array<{ uom: string; quantityDelta?: number }>
  created_at?: string
  updated_at?: string
}

function toCamelLine(row: AdjustmentLineApiRow): InventoryAdjustmentLine {
  return {
    id: row.id as string,
    lineNumber: row.lineNumber ?? row.line_number ?? 0,
    itemId: row.itemId ?? row.item_id ?? '',
    itemSku: row.itemSku ?? row.item_sku ?? null,
    itemName: row.itemName ?? row.item_name ?? null,
    locationId: row.locationId ?? row.location_id ?? '',
    locationCode: row.locationCode ?? row.location_code ?? null,
    locationName: row.locationName ?? row.location_name ?? null,
    uom: row.uom ?? '',
    quantityDelta: Number(row.quantityDelta ?? row.quantity_delta ?? 0),
    reasonCode: row.reasonCode ?? row.reason_code ?? '',
    notes: row.notes ?? null,
    createdAt: row.createdAt ?? row.created_at,
  }
}

function normalizeTotals(
  value?: Array<{ uom: string; quantityDelta?: number; quantity_delta?: number }>,
) {
  if (!value) return []
  return value
    .filter((entry) => entry?.uom)
    .map((entry) => ({
      uom: entry.uom,
      quantityDelta: Number(entry.quantityDelta ?? entry.quantity_delta ?? 0),
    }))
}

function toCamelAdjustment(row: AdjustmentApiRow): InventoryAdjustment {
  return {
    id: row.id as string,
    status: row.status ?? 'draft',
    occurredAt: row.occurredAt ?? row.occurred_at ?? '',
    inventoryMovementId: row.inventoryMovementId ?? row.inventory_movement_id ?? null,
    correctedFromAdjustmentId:
      row.correctedFromAdjustmentId ?? row.corrected_from_adjustment_id ?? null,
    isCorrected: row.isCorrected ?? row.is_corrected ?? false,
    notes: row.notes ?? null,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
    lines: Array.isArray(row.lines) ? row.lines.map(toCamelLine) : [],
  }
}

function toCamelSummary(row: AdjustmentSummaryApiRow): InventoryAdjustmentSummary {
  return {
    id: row.id as string,
    status: row.status ?? 'draft',
    occurredAt: row.occurredAt ?? row.occurred_at ?? '',
    inventoryMovementId: row.inventoryMovementId ?? row.inventory_movement_id ?? null,
    correctedFromAdjustmentId:
      row.correctedFromAdjustmentId ?? row.corrected_from_adjustment_id ?? null,
    isCorrected: row.isCorrected ?? row.is_corrected ?? false,
    notes: row.notes ?? null,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
    lineCount: row.lineCount ?? row.line_count ?? 0,
    totalsByUom: normalizeTotals(row.totalsByUom ?? row.totals_by_uom),
  }
}

export async function listInventoryAdjustments(
  params: AdjustmentListParams = {},
): Promise<InventoryAdjustmentListResponse> {
  const queryParams: Record<string, string | number> = {}
  if (params.status) queryParams.status = params.status
  if (params.occurredFrom) queryParams.occurred_from = params.occurredFrom
  if (params.occurredTo) queryParams.occurred_to = params.occurredTo
  if (params.itemId) queryParams.item_id = params.itemId
  if (params.locationId) queryParams.location_id = params.locationId
  if (params.limit) queryParams.limit = params.limit
  if (params.offset !== undefined) queryParams.offset = params.offset

  const response = await apiGet<unknown>('/inventory-adjustments', { params: queryParams })

  if (Array.isArray(response)) {
    return { data: response.map((row) => toCamelSummary(row as AdjustmentSummaryApiRow)) }
  }

  return {
    data: Array.isArray(response.data)
      ? response.data.map((row: AdjustmentSummaryApiRow) => toCamelSummary(row))
      : [],
    paging: response.paging,
  }
}

export async function getInventoryAdjustment(id: string): Promise<InventoryAdjustment> {
  const adjustment = await apiGet<AdjustmentApiRow>(`/inventory-adjustments/${id}`)
  return toCamelAdjustment(adjustment)
}

export async function createInventoryAdjustment(
  payload: AdjustmentPayload,
): Promise<InventoryAdjustment> {
  const adjustment = await apiPost<AdjustmentApiRow>('/inventory-adjustments', payload)
  return toCamelAdjustment(adjustment)
}

export async function updateInventoryAdjustment(
  id: string,
  payload: AdjustmentPayload,
): Promise<InventoryAdjustment> {
  const adjustment = await apiPut<AdjustmentApiRow>(`/inventory-adjustments/${id}`, payload)
  return toCamelAdjustment(adjustment)
}

export async function postInventoryAdjustment(
  id: string,
  payload?: { overrideNegative?: boolean; overrideReason?: string | null },
): Promise<InventoryAdjustment> {
  const adjustment = await apiPost<AdjustmentApiRow>(`/inventory-adjustments/${id}/post`, payload)
  return toCamelAdjustment(adjustment)
}

export async function cancelInventoryAdjustment(id: string): Promise<InventoryAdjustment> {
  const adjustment = await apiPost<AdjustmentApiRow>(`/inventory-adjustments/${id}/cancel`)
  return toCamelAdjustment(adjustment)
}

export async function deleteInventoryAdjustment(id: string): Promise<void> {
  await apiDelete(`/inventory-adjustments/${id}`)
}
