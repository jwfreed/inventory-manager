import { Banner } from '../../../shared/ui/Banner'
import type { Diagnostic } from '../inventoryDiagnostics'
import type { HealthActionId, ItemHealthResult } from '../itemDetail.models'
import { ItemHealthStatus } from '../itemDetail.models'

export type ItemHealthBannerProps = {
  health: ItemHealthResult
  diagnostics?: Diagnostic[]
  onAction?: (actionId: HealthActionId) => void
}

export function ItemHealthBanner({ health, diagnostics = [], onAction }: ItemHealthBannerProps) {
  const hasDiagnostics = diagnostics.length > 0
  const detailReasons = hasDiagnostics ? health.reasons : health.reasons.slice(1)
  const severity = hasDiagnostics
    ? diagnostics.some((diagnostic) => diagnostic.severity === 'error')
      ? 'critical'
      : 'action'
    : health.status === ItemHealthStatus.READY
      ? 'info'
      : health.status === ItemHealthStatus.INVALID_CONVERSIONS
        ? 'critical'
        : 'action'

  return (
    <div className="space-y-3">
      <Banner
        severity={severity}
        title={
          hasDiagnostics
            ? 'Inventory anomaly detected'
            : health.status === ItemHealthStatus.READY
              ? 'Item ready for use'
              : 'Item not ready for use'
        }
        description={hasDiagnostics ? diagnostics[0]?.message : health.reasons[0]}
      />
      {(detailReasons.length > 0 || health.actions.length > 0 || hasDiagnostics) && (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm shadow-slate-950/5">
          {hasDiagnostics ? (
            <ul className="space-y-1 text-sm text-slate-700">
              {diagnostics.map((diagnostic) => (
                <li key={diagnostic.code}>• {diagnostic.message}</li>
              ))}
            </ul>
          ) : null}
          {detailReasons.length > 0 ? (
            <ul className="space-y-1 pt-3 text-sm text-slate-700">
              {detailReasons.map((reason) => (
                <li key={reason}>• {reason}</li>
              ))}
            </ul>
          ) : null}
          {health.actions.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {health.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                  onClick={() => onAction?.(action.id)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
