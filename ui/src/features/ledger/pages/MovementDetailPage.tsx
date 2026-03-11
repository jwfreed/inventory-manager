import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Banner,
  Button,
  ContextRail,
  DataTable,
  EmptyState,
  EntityPageLayout,
  ErrorState,
  LoadingSpinner,
  PageHeader,
  Panel,
  SectionNav,
  StatusCell,
  formatStatusLabel,
  statusTone,
} from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'
import { MovementLinesTable } from '../components/MovementLinesTable'
import {
  movementDetailSections,
  useMovementDetailViewModel,
} from '../hooks/useMovementDetailViewModel'

export default function MovementDetailPage() {
  const { movementId } = useParams<{ movementId: string }>()
  const navigate = useNavigate()
  const model = useMovementDetailViewModel({ movementId })

  useEffect(() => {
    if (model.movementQuery.isError && model.movementQuery.error?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [model.movementQuery.error, model.movementQuery.isError, navigate])

  const copyId = async () => {
    if (!movementId) return
    try {
      await navigator.clipboard.writeText(movementId)
    } catch {
      // ignore clipboard failures
    }
  }

  if (model.movementQuery.isLoading) {
    return <LoadingSpinner label="Loading movement..." />
  }

  if (model.movementQuery.isError && model.movementQuery.error) {
    return (
      <ErrorState
        error={model.movementQuery.error}
        onRetry={() => {
          void model.movementQuery.refetch()
        }}
      />
    )
  }

  if (!model.movementQuery.data) return null

  const movement = model.movementQuery.data

  return (
    <EntityPageLayout
      header={
        <section id="overview" className="space-y-6">
          <PageHeader
            title="Movement detail"
            subtitle="Review posting state, line deltas, and linked operational sources."
            action={
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => navigate('/movements')}>
                  Back to list
                </Button>
                <Button variant="secondary" size="sm" onClick={copyId}>
                  Copy ID
                </Button>
              </div>
            }
          />
        </section>
      }
      health={
        model.anomaly ? (
          <Banner
            severity={movement.status === 'draft' ? 'action' : 'critical'}
            title={model.anomaly.title}
            description={model.anomaly.message}
            action={
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    navigate(`/movements?externalRef=${encodeURIComponent(movement.externalRef ?? movement.id)}`)
                  }
                >
                  View movements
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    navigate(
                      movement.externalRef?.startsWith('inventory_adjustment:')
                        ? `/inventory-adjustments/${movement.externalRef.split(':')[1]}`
                        : '/inventory-adjustments/new',
                    )
                  }
                >
                  Adjust stock
                </Button>
              </div>
            }
          />
        ) : undefined
      }
      sectionNav={<SectionNav sections={movementDetailSections} ariaLabel="Movement sections" />}
      contextRail={<ContextRail sections={model.contextSections} />}
    >
      <Panel
        title="Movement overview"
        description="Posting state, source reference, and override metadata."
        actions={
          model.sourceLink ? (
            <Button variant="secondary" size="sm" onClick={() => navigate(model.sourceLink!.to)}>
              Open source
            </Button>
          ) : undefined
        }
      >
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-3 text-sm text-slate-700">
            <div className="flex flex-wrap items-center gap-3">
              <StatusCell
                label={formatStatusLabel(movement.status)}
                tone={statusTone(movement.status)}
                compact
              />
              <StatusCell label={movement.movementType} tone="neutral" compact />
              {model.negativeOverride ? (
                <StatusCell label="Anomaly" tone="danger" meta="Negative override" compact />
              ) : null}
            </div>
            <div>
              <span className="font-semibold text-slate-900">Occurred:</span>{' '}
              {formatDate(movement.occurredAt)}
            </div>
            <div>
              <span className="font-semibold text-slate-900">Posted:</span>{' '}
              {movement.postedAt ? formatDate(movement.postedAt) : '—'}
            </div>
            <div>
              <span className="font-semibold text-slate-900">Notes:</span> {movement.notes || '—'}
            </div>
          </div>
          <div className="space-y-3 text-sm text-slate-700">
            <div>
              <span className="font-semibold text-slate-900">External ref:</span>{' '}
              {movement.externalRef || '—'}
            </div>
            <div>
              <span className="font-semibold text-slate-900">Source:</span>{' '}
              {model.sourceLink ? (
                <Link className="text-brand-700 underline" to={model.sourceLink.to}>
                  {model.sourceLink.label}
                </Link>
              ) : (
                movement.externalRef || '—'
              )}
            </div>
            <div>
              <span className="font-semibold text-slate-900">Override actor:</span>{' '}
              {model.negativeOverride?.actorId || '—'}
            </div>
            <div>
              <span className="font-semibold text-slate-900">Override reason:</span>{' '}
              {model.negativeOverride?.reason || '—'}
            </div>
          </div>
        </div>
      </Panel>

      <section id="lines" className="space-y-6">
        <Panel title="Movement lines" description="Line-level stock deltas and reasons.">
          {model.linesQuery.isLoading ? <LoadingSpinner label="Loading lines..." /> : null}
          {model.linesQuery.isError && model.linesQuery.error ? (
            <ErrorState
              error={model.linesQuery.error}
              onRetry={() => {
                void model.linesQuery.refetch()
              }}
            />
          ) : null}
          {!model.linesQuery.isLoading && !model.linesQuery.isError && model.linesQuery.data ? (
            <MovementLinesTable lines={model.linesQuery.data} />
          ) : null}
          {!model.linesQuery.isLoading &&
          !model.linesQuery.isError &&
          model.linesQuery.data?.length === 0 ? (
            <EmptyState
              title="No movement lines"
              description="This movement has no line deltas to investigate."
            />
          ) : null}
        </Panel>
      </section>

      <section id="investigation" className="space-y-6">
        <Panel title="Totals by item" description="Net delta by item and unit of measure.">
          {model.totals.length === 0 ? (
            <EmptyState
              title="No totals available"
              description="Totals are derived from movement lines. No lines are currently present."
            />
          ) : (
            <DataTable
              rows={model.totals}
              rowKey={(total) => `${total.itemId}-${total.uom}`}
              columns={[
                {
                  id: 'item',
                  header: 'Item',
                  priority: 'primary',
                  cell: (total) => total.itemId,
                },
                {
                  id: 'uom',
                  header: 'UOM',
                  cell: (total) => total.uom,
                },
                {
                  id: 'delta',
                  header: 'Net delta',
                  align: 'right',
                  priority: 'anomaly',
                  cell: (total) => {
                    const sign = total.quantity > 0 ? '+' : total.quantity < 0 ? '−' : ''
                    return `${sign}${formatNumber(Math.abs(total.quantity))} ${total.uom}`
                  },
                },
              ]}
              getRowState={(total) => (total.quantity < 0 ? 'warning' : 'default')}
            />
          )}
        </Panel>
      </section>
    </EntityPageLayout>
  )
}
