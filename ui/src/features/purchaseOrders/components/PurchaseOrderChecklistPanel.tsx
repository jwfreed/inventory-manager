type ChecklistItem = {
  id: string
  label: string
  ok: boolean
}

type Props = {
  visible: boolean
  items: ChecklistItem[]
}

export function PurchaseOrderChecklistPanel({ visible, items }: Props) {
  if (!visible) return null

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">Ready to submit</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <div
            key={item.id}
            className={`flex items-center justify-between rounded-md border px-2 py-1 text-sm ${
              item.ok ? 'border-green-200 bg-white text-slate-700' : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}
          >
            <span>{item.label}</span>
            <span className={`text-xs font-semibold uppercase ${item.ok ? 'text-green-700' : 'text-amber-700'}`}>
              {item.ok ? 'Ready' : 'Missing'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
