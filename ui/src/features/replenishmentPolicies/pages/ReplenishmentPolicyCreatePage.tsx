import { useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ApiError } from '@api/types'
import { useItem } from '@features/items/queries'
import { kpisQueryKeys } from '@features/kpis/queries'
import { ErrorState, LoadingSpinner, PageHeader } from '@shared/ui'
import { createReplenishmentPolicy, type ReplenishmentPolicyInput } from '../api'
import { useReplenishmentPolicy, replenishmentPolicyQueryKeys } from '../queries'
import { ReplenishmentPolicyForm } from '../components/ReplenishmentPolicyForm'

export default function ReplenishmentPolicyCreatePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const source = searchParams.get('source')
  const fromPolicyId = searchParams.get('fromPolicyId')
  const preselectedItemId = searchParams.get('itemId')

  const duplicateQuery = useReplenishmentPolicy(fromPolicyId ?? undefined, {
    enabled: Boolean(fromPolicyId),
  })
  const preselectedItemQuery = useItem(preselectedItemId ?? undefined, {
    enabled: Boolean(preselectedItemId) && !Boolean(duplicateQuery.data?.itemId),
  })

  const mutation = useMutation({
    mutationFn: (payload: ReplenishmentPolicyInput) => createReplenishmentPolicy(payload),
    onSuccess: async (created) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: replenishmentPolicyQueryKeys.prefix() }),
        queryClient.invalidateQueries({ queryKey: kpisQueryKeys.replenishmentPoliciesPrefix() }),
        queryClient.invalidateQueries({ queryKey: kpisQueryKeys.replenishmentRecommendationsPrefix() }),
        queryClient.invalidateQueries({ queryKey: kpisQueryKeys.dashboardOverviewPrefix() }),
      ])
      navigate(
        source === 'dashboard'
          ? `/replenishment-policies/${created.id}?source=dashboard-created`
          : `/replenishment-policies/${created.id}`,
      )
    },
  })

  const initialPolicy = useMemo(() => {
    if (!duplicateQuery.data) return null
    return {
      ...duplicateQuery.data,
      id: undefined,
      status: 'active',
    }
  }, [duplicateQuery.data])

  if (duplicateQuery.isLoading || preselectedItemQuery.isLoading) {
    return <LoadingSpinner label="Loading policy form..." />
  }

  if (duplicateQuery.isError) {
    return <ErrorState error={duplicateQuery.error} onRetry={() => void duplicateQuery.refetch()} />
  }

  if (preselectedItemQuery.isError) {
    return <ErrorState error={preselectedItemQuery.error} onRetry={() => void preselectedItemQuery.refetch()} />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create replenishment policy"
        subtitle="Create a standalone item-location-UOM replenishment control without embedding policy editing into item maintenance."
      />

      <ReplenishmentPolicyForm
        initialPolicy={initialPolicy}
        preselectedItem={preselectedItemQuery.data ?? null}
        source={source}
        submitLabel="Create policy"
        isSubmitting={mutation.isPending}
        submitError={(mutation.error as ApiError | null) ?? null}
        onCancel={() => navigate('/replenishment-policies')}
        onSubmit={(payload) => mutation.mutate(payload)}
      />
    </div>
  )
}
