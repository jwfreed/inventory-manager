import { memo, useMemo, type CSSProperties, type ReactElement } from 'react'
import { List } from 'react-window'
import type { PurchaseOrderReceipt } from '@api/types'

type ReceiptItemProps = {
  receipt: PurchaseOrderReceipt
  isSelected: boolean
  onSelect: (receiptId: string) => void
  onClick: (receiptId: string) => void
}

const ReceiptItem = memo(({ receipt, isSelected, onSelect, onClick }: ReceiptItemProps) => {
  return (
    <div
      className={`
        flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer mx-2 my-1
        ${isSelected ? 'ring-2 ring-indigo-500 bg-indigo-50 border-indigo-300' : 'bg-white border-slate-200 hover:border-slate-300'}
      `}
      onClick={() => onClick(receipt.id)}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={() => onSelect(receipt.id)}
        className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
        onClick={(e) => e.stopPropagation()}
      />
      <div className="flex-1 grid grid-cols-4 gap-4">
        <div>
          <div className="text-xs text-slate-500">Receipt ID</div>
          <div className="text-sm font-medium text-slate-900 font-mono">{receipt.id}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">PO Number</div>
          <div className="text-sm font-medium text-slate-900">{receipt.purchaseOrderNumber || 'N/A'}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Received</div>
          <div className="text-sm text-slate-900">
            {receipt.receivedAt ? new Date(receipt.receivedAt).toLocaleDateString() : 'N/A'}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Status</div>
          <div className="text-sm">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
                ${receipt.status === 'posted' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}
              `}
            >
              {receipt.status}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
})

ReceiptItem.displayName = 'ReceiptItem'

type RowProps = {
  receipts: PurchaseOrderReceipt[]
  selectedReceiptIds: Set<string>
  onSelectReceipt: (receiptId: string) => void
  onClickReceipt: (receiptId: string) => void
}

function ReceiptRow({ index, style, receipts, selectedReceiptIds, onSelectReceipt, onClickReceipt }: {
  index: number
  style: CSSProperties
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
} & RowProps): ReactElement {
  const receipt = receipts[index]
  if (!receipt) return <div style={style} />

  return (
    <div style={style}>
      <ReceiptItem
        receipt={receipt}
        isSelected={selectedReceiptIds.has(receipt.id)}
        onSelect={onSelectReceipt}
        onClick={onClickReceipt}
      />
    </div>
  )
}

type VirtualReceiptListProps = {
  receipts: PurchaseOrderReceipt[]
  selectedReceiptIds: Set<string>
  onSelectReceipt: (receiptId: string) => void
  onClickReceipt: (receiptId: string) => void
  height?: number
  itemHeight?: number
}

export function VirtualReceiptList({
  receipts,
  selectedReceiptIds,
  onSelectReceipt,
  onClickReceipt,
  height = 600,
  itemHeight = 72,
}: VirtualReceiptListProps) {
  const rowProps = useMemo(
    () => ({
      receipts,
      selectedReceiptIds,
      onSelectReceipt,
      onClickReceipt,
    }),
    [receipts, selectedReceiptIds, onSelectReceipt, onClickReceipt],
  )

  if (receipts.length === 0) {
    return (
      <div className="text-center py-8 text-slate-500">
        <p>No receipts to display</p>
      </div>
    )
  }

  return (
    <List
      style={{ height, width: '100%' }}
      rowCount={receipts.length}
      rowHeight={itemHeight}
      rowComponent={ReceiptRow}
      rowProps={rowProps}
      className="scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-slate-100"
    />
  )
}
