import { apiGet } from '../../../api/http'
import type {
  InventorySnapshotRow,
  InventorySnapshotSummaryDetailed,
  InventorySnapshotSummaryDiagnostics,
} from '../../../api/types'
import { resolveWarehouseId } from '../../../api/warehouseContext'

export type InventorySnapshotParams = {
  warehouseId?: string
  itemId: string
  locationId: string
  uom?: string
}

export type InventorySnapshotSummaryParams = {
  warehouseId?: string
  itemId?: string
  locationId?: string
  limit?: number
  offset?: number
}

export async function getInventorySnapshot(params: InventorySnapshotParams): Promise<InventorySnapshotRow[]> {
  const warehouseId = await resolveWarehouseId({
    warehouseId: params.warehouseId,
    locationId: params.locationId
  })
  const response = await apiGet<InventorySnapshotRow[] | { data?: InventorySnapshotRow[] }>('/inventory-snapshot', {
    params: {
      warehouseId,
      itemId: params.itemId,
      locationId: params.locationId,
      ...(params.uom ? { uom: params.uom } : {}),
    },
  })

  if (Array.isArray(response)) return response
  return response.data ?? []
}

export async function listInventorySnapshotSummary(
  params: InventorySnapshotSummaryParams = {},
): Promise<InventorySnapshotRow[]> {
  const detailed = await listInventorySnapshotSummaryDetailed(params)
  return detailed.data
}

function emptySummaryDiagnostics(): InventorySnapshotSummaryDiagnostics {
  return {
    uomNormalizationDiagnostics: [],
    uomInconsistencies: [],
  }
}

function normalizeSummaryDiagnostics(
  diagnostics: InventorySnapshotSummaryDiagnostics | undefined,
): InventorySnapshotSummaryDiagnostics {
  const value = diagnostics ?? emptySummaryDiagnostics()
  const canonical =
    value.uomNormalizationDiagnostics && value.uomNormalizationDiagnostics.length > 0
      ? value.uomNormalizationDiagnostics
      : value.uomInconsistencies ?? []
  const normalizedEntries = canonical.map((entry) => ({
    ...entry,
    status: entry.status ?? 'INCONSISTENT',
    severity: entry.severity ?? 'action',
    canAggregate: entry.canAggregate ?? false,
    traces: entry.traces ?? [],
  }))
  return {
    ...value,
    uomNormalizationDiagnostics: normalizedEntries,
    uomInconsistencies: normalizedEntries,
  }
}

export async function listInventorySnapshotSummaryDetailed(
  params: InventorySnapshotSummaryParams = {},
): Promise<InventorySnapshotSummaryDetailed> {
  const warehouseId = await resolveWarehouseId({
    warehouseId: params.warehouseId,
    locationId: params.locationId
  })
  const response = await apiGet<
    | InventorySnapshotSummaryDetailed
    | {
        data?: InventorySnapshotRow[]
        diagnostics?: InventorySnapshotSummaryDiagnostics
      }
  >('/inventory-snapshot/summary', {
    params: {
      warehouseId,
      ...(params.itemId ? { itemId: params.itemId } : {}),
      ...(params.locationId ? { locationId: params.locationId } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
      ...(params.offset ? { offset: params.offset } : {}),
    },
  })
  if (Array.isArray((response as { data?: unknown }).data)) {
    return {
      data: (response as { data?: InventorySnapshotRow[] }).data ?? [],
      diagnostics: normalizeSummaryDiagnostics(
        (response as { diagnostics?: InventorySnapshotSummaryDiagnostics }).diagnostics,
      ),
    }
  }
  if (Array.isArray(response as unknown as InventorySnapshotRow[])) {
    return {
      data: response as unknown as InventorySnapshotRow[],
      diagnostics: emptySummaryDiagnostics(),
    }
  }
  return {
    data: response.data ?? [],
    diagnostics: normalizeSummaryDiagnostics(response.diagnostics),
  }
}
