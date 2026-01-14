type Props = {
  vendorReady: boolean
  shipToReady: boolean
  receivingReady: boolean
  expectedDateReady: boolean
  linesReady: boolean
}

export function PurchaseOrderReadinessPanel({
  vendorReady,
  shipToReady,
  receivingReady,
  expectedDateReady,
  linesReady,
}: Props) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">Submission readiness</div>
      <ul className="mt-2 space-y-2 text-sm text-slate-700">
        <li className="flex items-center justify-between">
          <span>Vendor selected</span>
          <span>{vendorReady ? '✓' : '—'}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>Ship-to location set</span>
          <span>{shipToReady ? '✓' : '—'}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>Receiving location set</span>
          <span>{receivingReady ? '✓' : '—'}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>Expected date valid</span>
          <span>{expectedDateReady ? '✓' : '—'}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>At least one valid line</span>
          <span>{linesReady ? '✓' : '—'}</span>
        </li>
      </ul>
      <p className="mt-3 text-xs text-slate-500">
        Submit becomes available only when all checks are complete.
      </p>
    </div>
  )
}
