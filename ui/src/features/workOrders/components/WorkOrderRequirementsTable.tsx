import { useMemo } from 'react'
import type { WorkOrderReadinessLine, WorkOrderRequirementLine } from '@api/types'
import { DataTable } from '@shared/ui'

type IssuedTotal = {
  componentItemId: string
  uom: string
  quantityIssued: number
}

type Props = {
  lines: Array<WorkOrderRequirementLine | WorkOrderReadinessLine>
  issuedTotals?: IssuedTotal[]
  componentLabel: (id: string, name?: string | null, sku?: string | null) => string
}

export function WorkOrderRequirementsTable({ lines, issuedTotals = [], componentLabel }: Props) {
  const issuedByKey = useMemo(() => {
    const map = new Map<string, number>()
    issuedTotals.forEach((issued) => {
      map.set(`${issued.componentItemId}:${issued.uom}`, issued.quantityIssued)
    })
    return map
  }, [issuedTotals])
  const hasReadiness = lines.some((line) => 'required' in line)

  return (
    <DataTable
      rows={lines}
      rowKey={(line) => `${line.componentItemId}-${line.lineNumber}-${line.uom}`}
      columns={[
        {
          id: 'line',
          header: 'Line',
          cell: (line) => line.lineNumber,
          cellClassName: 'font-mono text-xs text-slate-600',
        },
        {
          id: 'component',
          header: 'Component',
          cell: (line) => componentLabel(line.componentItemId, line.componentItemName, line.componentItemSku),
        },
        {
          id: 'required',
          header: 'Required',
          cell: (line) => `${'required' in line ? line.required : line.quantityRequired} ${line.uom}`,
        },
        ...(hasReadiness
          ? [
              {
                id: 'consumeLocation',
                header: 'Consume location',
                cell: (line: WorkOrderRequirementLine | WorkOrderReadinessLine) =>
                  'consumeLocationCode' in line
                    ? [line.consumeLocationCode, line.consumeLocationName].filter(Boolean).join(' — ') || 'Unresolved'
                    : 'Auto-derived',
              },
              {
                id: 'reserved',
                header: 'Reserved',
                cell: (line: WorkOrderRequirementLine | WorkOrderReadinessLine) =>
                  'reserved' in line ? `${line.reserved} ${line.uom}` : '0',
              },
              {
                id: 'available',
                header: 'Available',
                cell: (line: WorkOrderRequirementLine | WorkOrderReadinessLine) =>
                  'available' in line ? `${line.available} ${line.uom}` : '0',
              },
              {
                id: 'shortage',
                header: 'Shortage',
                cell: (line: WorkOrderRequirementLine | WorkOrderReadinessLine) =>
                  'shortage' in line ? (
                    <span className={line.shortage > 0 ? 'font-semibold text-rose-700' : 'text-emerald-700'}>
                      {line.shortage} {line.uom}
                    </span>
                  ) : (
                    `0 ${line.uom}`
                  ),
              },
            ]
          : []),
        {
          id: 'issued',
          header: 'Issued',
          cell: (line) => {
            const issued = issuedByKey.get(`${line.componentItemId}:${line.uom}`) ?? 0
            return (
              <span className="text-red-600">{issued ? `-${issued}` : '0'} {line.uom}</span>
            )
          },
        },
        {
          id: 'remaining',
          header: 'Remaining',
          cell: (line) => {
            const issued = issuedByKey.get(`${line.componentItemId}:${line.uom}`) ?? 0
            const remaining = Math.max(0, line.quantityRequired - issued)
            return (
              <span className="font-semibold text-slate-800">{remaining} {line.uom}</span>
            )
          },
        },
      ]}
    />
  )
}
