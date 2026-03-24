import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useItem } from '@features/items/queries'
import { useLocation } from '@features/locations/queries'
import { Banner, Button, EmptyState, ErrorState, LoadingSpinner, PageHeader, Panel, StatusCell } from '@shared/ui'
import { useReplenishmentPolicy } from '../queries'

function policyTypeLabel(policyType: string) {
  return policyType === 'q_rop' ? 'Fixed order / reorder point (s,Q)' : 'Min-Max (s,S)'
}

export default function ReplenishmentPolicyDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const source = searchParams.get('source')
  const policyQuery = useReplenishmentPolicy(id)
  const itemQuery = useItem(policyQuery.data?.itemId, { enabled: Boolean(policyQuery.data?.itemId) })
  const locationQuery = useLocation(policyQuery.data?.siteLocationId ?? undefined, {
    enabled: Boolean(policyQuery.data?.siteLocationId),
  })

  const title = useMemo(() => {
    if (itemQuery.data) return `${itemQuery.data.sku} — ${itemQuery.data.name}`
    return policyQuery.data?.id ?? 'Policy'
  }, [itemQuery.data, policyQuery.data?.id])

  if (policyQuery.isLoading) return <LoadingSpinner label="Loading replenishment policy..." />
  if (policyQuery.isError) return <ErrorState error={policyQuery.error} onRetry={() => void policyQuery.refetch()} />
  if (!policyQuery.data) {
    return (
      <EmptyState
        title="Policy not found"
        description="This replenishment policy no longer exists or is not available in the current tenant."
        action={<Button onClick={() => navigate('/replenishment-policies')}>Back to policies</Button>}
      />
    )
  }

  const policy = policyQuery.data

  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        subtitle="Read-only policy detail. Use duplicate-as-new to create a revised scoped policy."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => navigate('/replenishment-policies')}>
              Back to policies
            </Button>
            <Button onClick={() => navigate(`/replenishment-policies/new?fromPolicyId=${policy.id}`)}>
              Duplicate as new
            </Button>
          </div>
        }
      />

      {source === 'dashboard-created' ? (
        <Banner
          severity="info"
          title="Replenishment policy created"
          description="Dashboard monitoring will refresh with the new policy configuration."
          action={
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => navigate('/dashboard')}>
                Back to dashboard
              </Button>
              <Button size="sm" variant="secondary" onClick={() => navigate('/replenishment-policies')}>
                View all policies
              </Button>
            </div>
          }
        />
      ) : null}

      <Panel title="Scope summary" description="Stable policy scope dimensions.">
        <dl className="grid gap-4 md:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Item</dt>
            <dd className="mt-1 text-sm text-slate-900">
              {itemQuery.data ? `${itemQuery.data.sku} — ${itemQuery.data.name}` : policy.itemId}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Location</dt>
            <dd className="mt-1 text-sm text-slate-900">
              {locationQuery.data ? `${locationQuery.data.code} — ${locationQuery.data.name}` : (policy.siteLocationId ?? 'Global')}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">UOM</dt>
            <dd className="mt-1 text-sm text-slate-900">{policy.uom}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Status</dt>
            <dd className="mt-1">
              <StatusCell
                label={policy.status}
                tone={policy.status === 'active' ? 'success' : 'neutral'}
                compact
              />
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Policy summary" description="Trigger semantics and reorder point source.">
        <dl className="grid gap-4 md:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Policy type</dt>
            <dd className="mt-1 text-sm text-slate-900">{policyTypeLabel(policy.policyType)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Reorder point mode</dt>
            <dd className="mt-1 text-sm text-slate-900">
              {policy.reorderPointQty != null ? 'Manual' : 'Derived from lead time and demand'}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Reorder point</dt>
            <dd className="mt-1 text-sm text-slate-900">{policy.reorderPointQty ?? 'Derived at runtime'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Lead time / demand</dt>
            <dd className="mt-1 text-sm text-slate-900">
              {policy.leadTimeDays ?? '—'} days · {policy.demandRatePerDay ?? '—'} / day
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Quantity summary" description="How reorder quantity is calculated when the trigger is met.">
        <dl className="grid gap-4 md:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              {policy.policyType === 'q_rop' ? 'Fixed order quantity' : 'Order up to level'}
            </dt>
            <dd className="mt-1 text-sm text-slate-900">
              {policy.policyType === 'q_rop' ? policy.orderQuantityQty ?? '—' : policy.orderUpToLevelQty ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Order bounds</dt>
            <dd className="mt-1 text-sm text-slate-900">
              Min {policy.minOrderQty ?? '—'} · Max {policy.maxOrderQty ?? '—'}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Buffer summary" description="Additional supporting configuration stored on the policy record.">
        <dl className="grid gap-4 md:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Safety stock method</dt>
            <dd className="mt-1 text-sm text-slate-900">{policy.safetyStockMethod ?? 'none'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Safety stock quantity</dt>
            <dd className="mt-1 text-sm text-slate-900">{policy.safetyStockQty ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">PPIS periods</dt>
            <dd className="mt-1 text-sm text-slate-900">{policy.ppisPeriods ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Notes</dt>
            <dd className="mt-1 text-sm text-slate-900 whitespace-pre-wrap">{policy.notes || '—'}</dd>
          </div>
        </dl>
      </Panel>
    </div>
  )
}
