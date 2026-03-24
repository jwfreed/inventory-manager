import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Item, Location, ReplenishmentPolicy } from '@api/types'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { Banner, Button, DataTable, EmptyState, ErrorState, LoadingSpinner, PageHeader, Panel, Select, Input, StatusCell } from '@shared/ui'
import { useReplenishmentPoliciesList } from '../queries'

const PAGE_SIZE = 50

function policyTypeLabel(policyType: string) {
  return policyType === 'q_rop' ? 'Fixed order / reorder point (s,Q)' : 'Min-Max (s,S)'
}

function triggerLabel(policy: ReplenishmentPolicy) {
  if (policy.reorderPointQty != null) return `Manual · ${policy.reorderPointQty}`
  if (policy.leadTimeDays != null && policy.demandRatePerDay != null) return 'Derived'
  return 'Incomplete'
}

function orderRuleLabel(policy: ReplenishmentPolicy) {
  if (policy.policyType === 'q_rop') return `Fixed ${policy.orderQuantityQty ?? '—'}`
  return `Up to ${policy.orderUpToLevelQty ?? '—'}`
}

function labelForItem(item: Item | undefined, itemId: string) {
  if (!item) return itemId
  return `${item.sku} — ${item.name}`
}

function labelForLocation(location: Location | undefined, locationId: string | null) {
  if (!locationId) return 'Global'
  if (!location) return locationId
  return `${location.code} — ${location.name}`
}

export default function ReplenishmentPoliciesListPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const page = Number.parseInt(searchParams.get('page') ?? '0', 10) || 0
  const [statusFilter, setStatusFilter] = useState('')
  const [policyTypeFilter, setPolicyTypeFilter] = useState('')
  const [search, setSearch] = useState('')

  const policiesQuery = useReplenishmentPoliciesList({ limit: PAGE_SIZE, offset: page * PAGE_SIZE })
  const itemsExistQuery = useItemsList({ limit: 1, lifecycleStatus: 'Active' }, { staleTime: 60_000 })
  const itemsLookupQuery = useItemsList({ limit: 200, lifecycleStatus: 'Active' }, { staleTime: 60_000 })
  const locationsQuery = useLocationsList({ active: true, limit: 1000 }, { staleTime: 60_000 })

  const itemLookup = useMemo(() => {
    const lookup = new Map<string, Item>()
    itemsLookupQuery.data?.data?.forEach((item) => lookup.set(item.id, item))
    return lookup
  }, [itemsLookupQuery.data])

  const locationLookup = useMemo(() => {
    const lookup = new Map<string, Location>()
    locationsQuery.data?.data?.forEach((location) => lookup.set(location.id, location))
    return lookup
  }, [locationsQuery.data])

  const filteredPolicies = useMemo(() => {
    const rows = policiesQuery.data?.data ?? []
    const needle = search.trim().toLowerCase()
    return rows.filter((policy) => {
      if (statusFilter && policy.status !== statusFilter) return false
      if (policyTypeFilter && policy.policyType !== policyTypeFilter) return false
      if (!needle) return true
      const itemLabel = labelForItem(itemLookup.get(policy.itemId), policy.itemId)
      const locationLabel = labelForLocation(
        policy.siteLocationId ? locationLookup.get(policy.siteLocationId) : undefined,
        policy.siteLocationId,
      )
      return `${itemLabel} ${locationLabel} ${policy.uom} ${policy.status}`.toLowerCase().includes(needle)
    })
  }, [itemLookup, locationLookup, policiesQuery.data, policyTypeFilter, search, statusFilter])

  const source = searchParams.get('source')
  const hasItems = (itemsExistQuery.data?.data?.length ?? 0) > 0
  const showEmptyPolicies = !policiesQuery.isLoading && !policiesQuery.isError && hasItems && filteredPolicies.length === 0 && (policiesQuery.data?.data?.length ?? 0) === 0
  const showNoItems = !itemsExistQuery.isLoading && !itemsExistQuery.isError && !hasItems

  const updatePage = (nextPage: number) => {
    navigate(nextPage <= 0 ? '/replenishment-policies' : `/replenishment-policies?page=${nextPage}`)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Replenishment Policies"
        subtitle="Standalone operational controls scoped to item, location, and UOM."
        action={
          <Button onClick={() => navigate('/replenishment-policies/new')}>
            Create policy
          </Button>
        }
      />

      {source === 'dashboard' ? (
        <Banner
          severity="watch"
          title="Replenishment monitoring not configured"
          description="Create a replenishment policy to move dashboard monitoring into a configured state."
          action={
            <Button size="sm" onClick={() => navigate('/replenishment-policies/new?source=dashboard')}>
              Create policy
            </Button>
          }
        />
      ) : null}

      <Panel title="Filters" description="Reduce scan load by filtering status, policy type, or the current page of policy scopes.">
        <div className="grid gap-3 md:grid-cols-3">
          <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
          <Select value={policyTypeFilter} onChange={(event) => setPolicyTypeFilter(event.target.value)}>
            <option value="">All policy types</option>
            <option value="min_max">Min-Max (s,S)</option>
            <option value="q_rop">Fixed order / reorder point (s,Q)</option>
          </Select>
          <Input
            placeholder="Search current page"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </Panel>

      <Panel
        title="Policies"
        description="One policy record maps to one item, location, and UOM scope."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => updatePage(Math.max(0, page - 1))} disabled={page === 0}>
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => updatePage(page + 1)}
              disabled={(policiesQuery.data?.data?.length ?? 0) < PAGE_SIZE}
            >
              Next
            </Button>
          </div>
        }
      >
        {policiesQuery.isLoading || itemsExistQuery.isLoading ? <LoadingSpinner label="Loading replenishment policies..." /> : null}
        {policiesQuery.isError ? <ErrorState error={policiesQuery.error} onRetry={() => void policiesQuery.refetch()} /> : null}
        {!policiesQuery.isLoading && !policiesQuery.isError && showNoItems ? (
          <EmptyState
            title="No items available"
            description="Create an item before configuring replenishment policy scopes."
            action={
              <Button onClick={() => navigate('/items')}>
                Go to Items
              </Button>
            }
          />
        ) : null}
        {!policiesQuery.isLoading && !policiesQuery.isError && showEmptyPolicies ? (
          <EmptyState
            title="No replenishment policies configured"
            description="Create a policy to define how an item-location-UOM scope should replenish."
            action={
              <Button onClick={() => navigate(source === 'dashboard' ? '/replenishment-policies/new?source=dashboard' : '/replenishment-policies/new')}>
                Create policy
              </Button>
            }
          />
        ) : null}
        {!policiesQuery.isLoading && !policiesQuery.isError && !showNoItems && (policiesQuery.data?.data?.length ?? 0) > 0 ? (
          filteredPolicies.length > 0 ? (
            <DataTable
              rows={filteredPolicies}
              rowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/replenishment-policies/${row.id}`)}
              onRowOpen={(row) => navigate(`/replenishment-policies/${row.id}`)}
              columns={[
                {
                  id: 'item',
                  header: 'Item',
                  priority: 'primary',
                  cell: (row) => (
                    <div>
                      <div>{labelForItem(itemLookup.get(row.itemId), row.itemId)}</div>
                      <div className="text-xs text-slate-500">UOM {row.uom}</div>
                    </div>
                  ),
                },
                {
                  id: 'location',
                  header: 'Location',
                  cell: (row) => labelForLocation(
                    row.siteLocationId ? locationLookup.get(row.siteLocationId) : undefined,
                    row.siteLocationId,
                  ),
                },
                {
                  id: 'type',
                  header: 'Policy type',
                  cell: (row) => policyTypeLabel(row.policyType),
                },
                {
                  id: 'trigger',
                  header: 'Trigger',
                  cell: (row) => triggerLabel(row),
                },
                {
                  id: 'order-rule',
                  header: 'Order rule',
                  cell: (row) => orderRuleLabel(row),
                },
                {
                  id: 'status',
                  header: 'Status',
                  cell: (row) => (
                    <StatusCell
                      label={row.status}
                      tone={row.status === 'active' ? 'success' : 'neutral'}
                      compact
                    />
                  ),
                },
              ]}
              rowActions={(row) => (
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation()
                      navigate(`/replenishment-policies/${row.id}`)
                    }}
                  >
                    View
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation()
                      navigate(`/replenishment-policies/new?fromPolicyId=${row.id}`)
                    }}
                  >
                    Duplicate as new
                  </Button>
                </div>
              )}
            />
          ) : (
            <EmptyState
              title="No policies match these filters"
              description="Clear filters or adjust the current page search."
            />
          )
        ) : null}
      </Panel>
    </div>
  )
}
