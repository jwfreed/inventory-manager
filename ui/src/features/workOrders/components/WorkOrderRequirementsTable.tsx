import { useMemo } from 'react'
import type { WorkOrderRequirementLine } from '../../../api/types'
import { DataTable } from '../../../shared'

type IssuedTotal = {
  componentItemId: string
  uom: string
  quantityIssued: number
}

type Props = {
  lines: WorkOrderRequirementLine[]
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
          cell: (line) => `${line.quantityRequired} ${line.uom}`,
        },
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
