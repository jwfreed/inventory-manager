import { useQuery } from '@tanstack/react-query'
import { apiPost } from '../../../api/http'
import type {
  UomDiagnosticSeverity,
  UomNormalizationStatus,
  UomResolutionTrace,
} from '../../../api/types'

export type UomConversionPreview = {
  qty: string
  exactQty: string
  warnings: string[]
  status: UomNormalizationStatus
  severity: UomDiagnosticSeverity
  canAggregate: boolean
  traces: UomResolutionTrace[]
}

type PreviewParams = {
  qty: number | string
  fromUom: string
  toUom: string
  itemId?: string
}

export async function previewUomConversion(params: PreviewParams) {
  return apiPost<UomConversionPreview>('/uoms/convert', {
    qty: params.qty,
    fromUom: params.fromUom,
    toUom: params.toUom,
    itemId: params.itemId,
    roundingContext: 'transfer',
    contextPrecision: 6,
  })
}

export function useUomConversionPreview(params: PreviewParams | null, enabled = true) {
  return useQuery({
    queryKey: ['uom-conversion-preview', params],
    queryFn: () => previewUomConversion(params as PreviewParams),
    enabled: Boolean(params && enabled),
    staleTime: 5 * 60 * 1000,
  })
}
