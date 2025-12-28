import type { Putaway } from '@api/types'
import { Badge, DataTable } from '@shared/ui'

type Props = {
  putaway: Putaway
}

export function PutawaySummaryTable({ putaway }: Props) {
  const variantForStatus = (status?: string | null) => {
    const normalized = (status ?? '').toLowerCase()
    if (normalized.includes('void') || normalized.includes('cancel')) return 'danger' as const
    if (normalized.includes('post') || normalized.includes('complete')) return 'success' as const
    if (normalized.includes('partial')) return 'info' as const
    if (normalized.includes('draft') || normalized.includes('plan')) return 'warning' as const
    return 'neutral' as const
  }
  const buildQcLink = (receiptLineId: string) => {
    if (!putaway.purchaseOrderReceiptId) return ''
    const params = new URLSearchParams({
      receiptId: putaway.purchaseOrderReceiptId,
      qcLineId: receiptLineId,
    })
    return `/receiving?${params.toString()}`
  }

  return (
    <div>
      <div className="text-sm text-slate-700">
        Status: <Badge variant={variantForStatus(putaway.status)}>{putaway.status}</Badge>
      </div>
      <div className="mt-2">
        <DataTable
          rows={putaway.lines}
          rowKey={(line) => line.id}
          columns={[
            { id: 'line', header: 'Line', cell: (line) => line.lineNumber },
            { id: 'receiptLine', header: 'Receipt line', cell: (line) => line.purchaseOrderReceiptLineId },
            {
              id: 'fromTo',
              header: 'From → To',
              cell: (line) => `${line.fromLocationId} → ${line.toLocationId}`,
            },
            {
              id: 'qty',
              header: 'Qty',
              cell: (line) => `${line.quantityPlanned} ${line.uom}`,
            },
            {
              id: 'status',
              header: 'Status',
              cell: (line) => <Badge variant={variantForStatus(line.status)}>{line.status}</Badge>,
            },
            {
              id: 'qc',
              header: 'QC',
              cell: (line) => {
                const qcLink = buildQcLink(line.purchaseOrderReceiptLineId)
                return qcLink ? (
                  <a className="text-xs text-slate-500 underline" href={qcLink}>
                    Review QC
                  </a>
                ) : (
                  <span className="text-xs text-slate-400">—</span>
                )
              },
            },
          ]}
        />
      </div>
    </div>
  )
}
