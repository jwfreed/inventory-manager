import { useQuery } from '@tanstack/react-query'
import type { Item, InventorySnapshotRow, UomConversion } from '../../../api/types'
import { previewUomConversion } from '../api/uomSystem'
import {
  buildManualConversionEntries,
  checkSystemConversions,
  normalizeUomCode,
} from '../itemDetail.logic'
import type { UnitConversionState } from '../itemDetail.models'

type Params = {
  item?: Item | null
  stockRows: InventorySnapshotRow[]
  conversions: UomConversion[]
}

export function useUnitConversions({ item, stockRows, conversions }: Params) {
  const canonicalUom = item?.canonicalUom?.trim() || item?.defaultUom?.trim() || null
  const systemDetected = checkSystemConversions(item)

  const candidateUoms = Array.from(
    new Set(
      [
        canonicalUom,
        item?.stockingUom,
        item?.defaultUom,
        ...stockRows.map((row) => row.uom),
        ...conversions.flatMap((conversion) => [conversion.fromUom, conversion.toUom]),
      ]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  )

  const manualEntries = buildManualConversionEntries(conversions, canonicalUom)

  const derivedQuery = useQuery({
    queryKey: ['items', 'derived-conversions', item?.id, canonicalUom, candidateUoms],
    enabled: Boolean(systemDetected && item?.id && canonicalUom && candidateUoms.length > 0),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const derived = new Map<string, number>()
      const missingUnits: string[] = []

      await Promise.all(
        candidateUoms
          .filter((uom) => normalizeUomCode(uom) !== normalizeUomCode(canonicalUom))
          .map(async (fromUom) => {
            try {
              const preview = await previewUomConversion({
                qty: 1,
                fromUom,
                toUom: canonicalUom as string,
                itemId: item?.id,
              })
              const qty = Number(preview.exactQty || preview.qty)
              if (Number.isFinite(qty) && qty > 0) {
                derived.set(normalizeUomCode(fromUom), qty)
              } else {
                missingUnits.push(fromUom)
              }
            } catch {
              missingUnits.push(fromUom)
            }
          }),
      )

      return {
        factorByUom: derived,
        missingUnits,
      }
    },
  })

  const factorByUom = new Map<string, number>()
  if (canonicalUom) {
    factorByUom.set(normalizeUomCode(canonicalUom), 1)
  }

  const derivedEntries =
    canonicalUom && derivedQuery.data
      ? Array.from(derivedQuery.data.factorByUom.entries())
          .map(([key, factor]) => {
            const sourceUom =
              candidateUoms.find((candidate) => normalizeUomCode(candidate) === key) ?? key
            factorByUom.set(key, factor)
            return {
              key: `system:${sourceUom}:${canonicalUom}`,
              fromUom: sourceUom,
              toUom: canonicalUom,
              factor,
              inverseFactor: 1 / factor,
              source: 'system' as const,
            }
          })
          .sort((left, right) => left.fromUom.localeCompare(right.fromUom))
      : []

  manualEntries.forEach((entry) => {
    if (!factorByUom.has(normalizeUomCode(entry.fromUom))) {
      factorByUom.set(normalizeUomCode(entry.fromUom), entry.factor)
    }
  })

  const missingUnits =
    derivedQuery.data?.missingUnits.filter(
      (uom) => !factorByUom.has(normalizeUomCode(uom)),
    ) ?? []

  const state: UnitConversionState = {
    systemDetected,
    canonicalUom,
    conversions: systemDetected && missingUnits.length === 0 ? derivedEntries : [...derivedEntries, ...manualEntries],
    factorByUom,
    mode: systemDetected && missingUnits.length === 0 ? 'derived' : 'manual',
    missingUnits,
  }

  return {
    ...derivedQuery,
    data: state,
    candidateUoms,
    manualEntries,
    derivedEntries,
  }
}
