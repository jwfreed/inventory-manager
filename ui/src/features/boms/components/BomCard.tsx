import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { activateBomVersion } from '../api/boms'
import { bomsQueryKeys, useBom } from '../queries'
import type { ApiError, Bom } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { LoadingSpinner } from '../../../components/Loading'
import { ErrorState } from '../../../components/ErrorState'
import { Modal } from '../../../components/Modal'
import { formatDate } from '@shared/formatters'

type Props = {
  bomId: string
  fallback?: Bom
  onChanged?: () => void
  onDuplicate?: (bom: Bom, version: Bom['versions'][number]) => void
}

export function BomCard({ bomId, fallback, onChanged, onDuplicate }: Props) {
  const queryClient = useQueryClient()
  const bomQuery = useBom(bomId, { placeholderData: fallback })
  const [pendingActivation, setPendingActivation] = useState<Bom['versions'][number] | null>(null)

  const activateMutation = useMutation({
    mutationFn: (versionId: string) =>
      activateBomVersion(versionId, { effectiveFrom: new Date().toISOString() }),
    onSuccess: () => {
      void bomQuery.refetch()
      void queryClient.invalidateQueries({ queryKey: bomsQueryKeys.all })
      setPendingActivation(null)
      onChanged?.()
    },
  })

  if (bomQuery.isLoading) return <LoadingSpinner label="Loading BOM..." />
  if (bomQuery.isError || !bomQuery.data) {
    return <ErrorState error={bomQuery.error as unknown as ApiError} onRetry={() => void bomQuery.refetch()} />
  }

  const bom = bomQuery.data
  const activeVersion = useMemo(
    () => bom.versions.find((version) => version.status === 'active'),
    [bom.versions],
  )

  return (
    <Card title={`BOM ${bom.bomCode}`} description={`Output UOM: ${bom.defaultUom}`}>
      {activateMutation.isError && (
        <Alert
          variant="error"
          title="Activation failed"
          message={(activateMutation.error as ApiError).message}
          className="mb-3"
        />
      )}
      <div className="space-y-4">
        {bom.versions.map((version) => (
          <div
            key={version.id}
            className="rounded-lg border border-slate-200 p-3 shadow-sm bg-white space-y-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm">
                <Badge variant="neutral">v{version.versionNumber}</Badge>
                <Badge variant={version.status === 'active' ? 'success' : 'warning'}>
                  {version.status}
                </Badge>
                <span className="text-slate-600">
                  Yield: {version.yieldQuantity} {version.yieldUom}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {onDuplicate && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onDuplicate(bom, version)}
                  >
                    New version
                  </Button>
                )}
                {version.status !== 'active' && (
                  <Button
                    size="sm"
                    onClick={() => setPendingActivation(version)}
                    disabled={activateMutation.isPending}
                  >
                    Activate
                  </Button>
                )}
              </div>
            </div>
            <div className="text-xs text-slate-600">
              Effective: {version.effectiveFrom ? formatDate(version.effectiveFrom) : '—'} →{' '}
              {version.effectiveTo ? formatDate(version.effectiveTo) : 'open'}
            </div>
            <div className="text-sm text-slate-700">Components</div>
            <div className="overflow-hidden rounded border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
                      Line
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
                      Component
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
                      Qty per
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
                      UOM
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
                      Scrap
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {version.components.map((c) => (
                    <tr key={c.id}>
                      <td className="px-3 py-2 text-sm text-slate-800">{c.lineNumber}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">
                        <Link
                          to={`/items/${c.componentItemId}`}
                          className="text-brand-700 hover:underline"
                        >
                          {c.componentItemSku || c.componentItemName ? (
                            <div>
                              <div className="font-medium">
                                {c.componentItemSku || c.componentItemName}
                              </div>
                              {c.componentItemSku && c.componentItemName && (
                                <div className="text-xs text-slate-500">{c.componentItemName}</div>
                              )}
                            </div>
                          ) : (
                            c.componentItemId
                          )}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-800">{c.quantityPer}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">{c.uom}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">
                        {c.scrapFactor ?? '—'}
                      </td>
                    </tr>
                  ))}
                  {version.components.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-2 text-sm text-slate-600">
                        No components found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        {bom.versions.length === 0 && <div className="text-sm text-slate-600">No versions yet.</div>}
      </div>
      <Modal
        isOpen={Boolean(pendingActivation)}
        onClose={() => setPendingActivation(null)}
        title="Activate BOM version"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPendingActivation(null)}>
              Cancel
            </Button>
            {pendingActivation && (
              <Button onClick={() => activateMutation.mutate(pendingActivation.id)}>
                Activate
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-2 text-sm text-slate-700">
          <div>
            Activating this version will deactivate{' '}
            {activeVersion ? `v${activeVersion.versionNumber}` : 'any current active version'}.
          </div>
          {pendingActivation && (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              Activate v{pendingActivation.versionNumber} for BOM {bom.bomCode}
            </div>
          )}
        </div>
      </Modal>
    </Card>
  )
}
