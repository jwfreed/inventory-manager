import { memo } from 'react'
import { Badge, Button } from '@shared/ui'

type Props = {
  isOnline: boolean
  pendingCount: number
  isSyncing: boolean
  onSync?: () => void
  onViewQueue?: () => void
}

export const OfflineIndicator = memo(({ isOnline, pendingCount, isSyncing, onSync, onViewQueue }: Props) => {
  if (isOnline && pendingCount === 0) {
    return null
  }

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div className="bg-white rounded-lg shadow-lg border border-slate-200 p-4 max-w-sm">
        <div className="flex items-start gap-3">
          {/* Status Icon */}
          <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
            !isOnline ? 'bg-amber-100' : isSyncing ? 'bg-blue-100' : 'bg-green-100'
          }`}>
            {!isOnline ? (
              <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414" />
              </svg>
            ) : isSyncing ? (
              <svg className="w-6 h-6 text-blue-600 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm font-semibold text-slate-900">
                {!isOnline ? 'Offline Mode' : isSyncing ? 'Syncing...' : 'Sync Complete'}
              </h3>
              {pendingCount > 0 && (
                <Badge variant="warning">{pendingCount}</Badge>
              )}
            </div>

            <p className="text-xs text-slate-600">
              {!isOnline ? (
                <>Changes will be saved locally and synced when online.</>
              ) : isSyncing ? (
                <>Syncing {pendingCount} pending operation{pendingCount !== 1 ? 's' : ''}...</>
              ) : pendingCount > 0 ? (
                <>{pendingCount} operation{pendingCount !== 1 ? 's' : ''} pending sync.</>
              ) : (
                <>All changes synced successfully.</>
              )}
            </p>

            {/* Actions */}
            {pendingCount > 0 && (
              <div className="flex items-center gap-2 mt-3">
                {isOnline && !isSyncing && onSync && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={onSync}
                  >
                    Sync Now
                  </Button>
                )}
                {onViewQueue && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={onViewQueue}
                  >
                    View Queue
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Close button (only show when online and synced) */}
          {isOnline && pendingCount === 0 && (
            <button
              className="flex-shrink-0 text-slate-400 hover:text-slate-600 transition-colors"
              aria-label="Dismiss"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
})

OfflineIndicator.displayName = 'OfflineIndicator'
