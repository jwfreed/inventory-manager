import type { ApiError, Bom, BomVersion, Item } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { EmptyState } from '../../../shared/ui/EmptyState'
import { Panel } from '../../../shared/ui/Panel'
import { BomCard } from '../../boms/components/BomCard'
import { BomForm } from '../../boms/components/BomForm'

type BomSummary = {
  activeBom?: Bom
  activeVersion?: BomVersion
  versionCount: number
}

type Props = {
  item: Item
  summary: BomSummary
  boms: Bom[]
  isLoading: boolean
  error?: ApiError | null
  showComposer: boolean
  message?: string | null
  onToggleComposer: () => void
  onCreateWorkOrder: () => void
  onCreated: () => void
  onRefetch: () => void
  onDuplicate: (payload: { bom?: Bom; version?: BomVersion }) => void
}

export function BOMPanel({
  item,
  summary,
  boms,
  isLoading,
  error,
  showComposer,
  message,
  onToggleComposer,
  onCreateWorkOrder,
  onCreated,
  onRefetch,
  onDuplicate,
}: Props) {
  const requiresBom = item.type === 'wip' || item.type === 'finished'

  return (
    <Panel
      title="BOM panel"
      description="Versioned production definitions with a single active version."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onToggleComposer}>
            {showComposer ? 'Close composer' : 'New BOM version'}
          </Button>
          <Button size="sm" onClick={onCreateWorkOrder} disabled={!summary.activeBom}>
            Create work order
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Active BOM</div>
            <div className="mt-2 text-lg font-semibold text-slate-950">
              {summary.activeBom && summary.activeVersion
                ? `${summary.activeBom.bomCode} · v${summary.activeVersion.versionNumber}`
                : 'No active BOM'}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Versions</div>
            <div className="mt-2 text-lg font-semibold text-slate-950">{summary.versionCount}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Manufacturing use</div>
            <div className="mt-2 text-lg font-semibold text-slate-950">
              {summary.activeBom ? 'Ready' : requiresBom ? 'Blocked' : 'Optional'}
            </div>
          </div>
        </div>

        {message ? <Alert variant="success" title="BOM updated" message={message} /> : null}
        {isLoading ? <LoadingSpinner label="Loading BOMs..." /> : null}
        {error ? <ErrorState error={error} onRetry={onRefetch} /> : null}

        {showComposer ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <BomForm
              outputItemId={item.id}
              defaultUom={item.defaultUom || undefined}
              onSuccess={onCreated}
            />
          </div>
        ) : null}

        {!isLoading && !error && boms.length === 0 ? (
          <EmptyState
            title={requiresBom ? 'BOM required for production' : 'No BOM required'}
            description={
              requiresBom
                ? 'This item cannot be produced until a BOM exists and one version is active.'
                : 'Raw and packaging items can operate without a BOM.'
            }
            action={
              requiresBom ? (
                <Button size="sm" onClick={onToggleComposer}>
                  Create BOM
                </Button>
              ) : undefined
            }
          />
        ) : null}

        <div className="grid gap-4">
          {boms.map((bom) => (
            <BomCard
              key={bom.id}
              bomId={bom.id}
              fallback={bom}
              onChanged={onRefetch}
              onDuplicate={(sourceBom, sourceVersion) =>
                onDuplicate({ bom: sourceBom, version: sourceVersion })
              }
            />
          ))}
        </div>
      </div>
    </Panel>
  )
}
