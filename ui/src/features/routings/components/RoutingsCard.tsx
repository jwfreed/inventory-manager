import { PencilIcon, PlusIcon } from '@heroicons/react/24/outline'
import { formatDate } from '@shared/formatters'
import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { createRouting, getRoutingsByItemId, getWorkCenters, updateRouting } from '../api'
import type { Routing } from '../types'
import { RoutingForm } from './RoutingForm'

interface RoutingsCardProps {
  itemId: string
}

export const RoutingsCard: React.FC<RoutingsCardProps> = ({ itemId }) => {
  const [isEditing, setIsEditing] = useState(false)
  const [editingRouting, setEditingRouting] = useState<Routing | null>(null)
  const queryClient = useQueryClient()

  const { data: routings, isLoading: isLoadingRoutings } = useQuery({
    queryKey: ['routings', itemId],
    queryFn: () => getRoutingsByItemId(itemId),
  })

  const { data: workCenters } = useQuery({
    queryKey: ['workCenters'],
    queryFn: getWorkCenters,
  })

  const workCenterMap = React.useMemo(() => {
    const map = new Map<string, string>()
    workCenters?.forEach((wc) => map.set(wc.id, wc.name))
    return map
  }, [workCenters])

  const createMutation = useMutation({
    mutationFn: createRouting,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routings', itemId] })
      setIsEditing(false)
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Routing> }) => updateRouting(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routings', itemId] })
      setIsEditing(false)
      setEditingRouting(null)
    },
  })

  const handleSubmit = (data: Partial<Routing>) => {
    if (editingRouting) {
      updateMutation.mutate({ id: editingRouting.id, data })
      return
    }

    createMutation.mutate({ ...data, itemId })
  }

  const handleEdit = (routing: Routing) => {
    setEditingRouting(routing)
    setIsEditing(true)
  }

  const handleAddNew = () => {
    setEditingRouting(null)
    setIsEditing(true)
  }

  const handleCancel = () => {
    setIsEditing(false)
    setEditingRouting(null)
  }

  if (isLoadingRoutings) return <LoadingSpinner label="Loading routings..." />

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-sm text-slate-600">
            Manage the process definition for this item with explicit versioning, statuses, and ordered steps.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{routings?.length ?? 0} routing{(routings?.length ?? 0) === 1 ? '' : 's'}</Badge>
            <Badge variant="info">Keyboard-safe table layout</Badge>
          </div>
        </div>
        <Button size="sm" onClick={handleAddNew}>
          <PlusIcon className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Add routing
        </Button>
      </div>

      {isEditing && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="mb-4">
            <div className="text-base font-semibold text-slate-900">
              {editingRouting ? 'Edit routing' : 'Add routing'}
            </div>
            <div className="text-sm text-slate-600">
              Define the route as a versioned manufacturing template for this item.
            </div>
          </div>
          <RoutingForm
            itemId={itemId}
            initialData={editingRouting || {}}
            onSubmit={handleSubmit}
            onCancel={handleCancel}
          />
        </div>
      )}

      {!routings || routings.length === 0 ? (
        <EmptyState
          title="No routings configured"
          description="Create a routing when the item requires a defined production sequence or work-center assignment."
          action={
            <Button size="sm" onClick={handleAddNew}>
              Create routing
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {routings.map((routing) => (
            <div key={routing.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-5 py-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-slate-900">{routing.name}</h3>
                      <Badge variant="neutral">v{routing.version}</Badge>
                      {routing.isDefault && <Badge variant="success">Default</Badge>}
                      <Badge
                        variant={
                          routing.status === 'active'
                            ? 'success'
                            : routing.status === 'draft'
                              ? 'warning'
                              : 'danger'
                        }
                      >
                        {routing.status}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
                      <span>{routing.steps?.length || 0} steps</span>
                      <span>Updated {formatDate(routing.updatedAt)}</span>
                    </div>
                    {routing.notes && <p className="text-sm leading-6 text-slate-600">{routing.notes}</p>}
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => handleEdit(routing)}>
                    <PencilIcon className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    Edit
                  </Button>
                </div>
              </div>

              {routing.steps && routing.steps.length > 0 ? (
                <div className="overflow-x-auto px-5 py-4">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead>
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Seq
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Production area
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Description
                        </th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Setup
                        </th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Run
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {routing.steps.map((step) => (
                        <tr key={step.id ?? `${routing.id}-${step.sequenceNumber}`}>
                          <td className="px-3 py-3 text-sm font-medium text-slate-900">{step.sequenceNumber}</td>
                          <td className="px-3 py-3 text-sm text-slate-700">
                            {workCenterMap.get(step.workCenterId) || step.workCenterId}
                          </td>
                          <td className="px-3 py-3 text-sm text-slate-700">{step.description || '—'}</td>
                          <td className="px-3 py-3 text-right text-sm text-slate-700">
                            {step.setupTimeMinutes} min
                          </td>
                          <td className="px-3 py-3 text-right text-sm text-slate-700">
                            {step.runTimeMinutes} min
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-5 py-4 text-sm text-slate-500">No steps defined yet.</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
