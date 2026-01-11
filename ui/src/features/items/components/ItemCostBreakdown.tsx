import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiError } from '../../../api/types'
import { rollItemCost, getItemCostHistory, previewBomCost } from '../../../api/costs'
import { Alert } from '../../../components/Alert'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { LoadingSpinner } from '../../../components/Loading'
import { Modal } from '../../../components/Modal'
import { formatDate } from '@shared/formatters'

type Props = {
  itemId: string
  itemSku: string
  itemName: string
  itemType: 'raw' | 'wip' | 'finished' | 'packaging'
  rolledCost: number | null
  rolledCostAt: string | null
  costMethod: string | null
  activeBomVersionId?: string | null
}

export function ItemCostBreakdown({
  itemId,
  itemSku,
  itemName,
  itemType,
  rolledCost,
  rolledCostAt,
  costMethod,
  activeBomVersionId
}: Props) {
  const queryClient = useQueryClient()
  const [showHistory, setShowHistory] = useState(false)
  const [showConfirmRoll, setShowConfirmRoll] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  // Query for cost history
  const historyQuery = useQuery({
    queryKey: ['item-cost-history', itemId],
    queryFn: () => getItemCostHistory(itemId, { limit: 20 }),
    enabled: showHistory
  })

  // Query for cost preview
  const previewQuery = useQuery({
    queryKey: ['bom-cost-preview', activeBomVersionId],
    queryFn: () => activeBomVersionId ? previewBomCost(activeBomVersionId) : Promise.reject('No BOM'),
    enabled: showPreview && Boolean(activeBomVersionId)
  })

  // Mutation for rolling cost
  const rollMutation = useMutation({
    mutationFn: () => rollItemCost(itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['item', itemId] })
      queryClient.invalidateQueries({ queryKey: ['item-cost-history', itemId] })
      setShowConfirmRoll(false)
    }
  })

  // Only show for WIP/finished goods
  if (itemType !== 'wip' && itemType !== 'finished') {
    return null
  }

  const isStale = historyQuery.data?.isStale ?? false
  const hasActiveBom = Boolean(activeBomVersionId)

  return (
    <>
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-lg font-semibold text-slate-900">Rolled Cost</h3>
              {isStale && (
                <Badge variant="warning">Stale - Recalculate</Badge>
              )}
              {costMethod === 'rolled' && rolledCost !== null && !isStale && (
                <Badge variant="success">Up-to-date</Badge>
              )}
            </div>
            
            <div className="grid gap-3 sm:grid-cols-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Rolled Cost</div>
                <div className="font-mono text-lg font-semibold text-slate-900">
                  {rolledCost !== null ? `$${rolledCost.toFixed(6)}` : 'Not calculated'}
                </div>
                {rolledCostAt && (
                  <div className="text-xs text-slate-500">
                    Last calculated: {formatDate(rolledCostAt)}
                  </div>
                )}
              </div>
              
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Cost Method</div>
                <div className="font-semibold text-slate-900">
                  {costMethod || 'Not set'}
                </div>
              </div>
              
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">BOM Status</div>
                <div className="font-semibold text-slate-900">
                  {hasActiveBom ? 'Active BOM found' : 'No active BOM'}
                </div>
              </div>
            </div>

            {isStale && (
              <Alert
                variant="warning"
                title="Cost is stale"
                message="Component costs have changed since the last roll-up. Recalculate to get the current cost."
                className="mt-3"
              />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowConfirmRoll(true)}
              disabled={!hasActiveBom || rollMutation.isPending}
            >
              {rollMutation.isPending ? 'Calculating...' : 'Recalculate Cost'}
            </Button>
            
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowPreview(true)}
              disabled={!hasActiveBom}
            >
              Preview Breakdown
            </Button>
            
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowHistory(!showHistory)}
            >
              {showHistory ? 'Hide History' : 'Show History'}
            </Button>
          </div>
        </div>

        {rollMutation.isError && (
          <Alert
            variant="error"
            title="Failed to recalculate cost"
            message={(rollMutation.error as unknown as ApiError).message}
            className="mt-3"
          />
        )}

        {rollMutation.isSuccess && rollMutation.data && (
          <Alert
            variant="success"
            title="Cost recalculated"
            message={`New rolled cost: $${rollMutation.data.rolledCost.toFixed(6)}`}
            className="mt-3"
          />
        )}
      </Card>

      {/* Cost History */}
      {showHistory && (
        <Card>
          <h4 className="text-md font-semibold text-slate-900 mb-3">Cost History</h4>
          
          {historyQuery.isLoading && <LoadingSpinner label="Loading history..." />}
          
          {historyQuery.isError && (
            <Alert
              variant="error"
              title="Failed to load history"
              message={(historyQuery.error as unknown as ApiError).message}
            />
          )}
          
          {historyQuery.data && historyQuery.data.history.length === 0 && (
            <div className="text-sm text-slate-600">No cost history yet.</div>
          )}
          
          {historyQuery.data && historyQuery.data.history.length > 0 && (
            <div className="space-y-2">
              {historyQuery.data.history.map((record) => (
                <div
                  key={record.id}
                  className="border border-slate-200 rounded-lg p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="info">
                          {record.costType}
                        </Badge>
                        <span className="text-xs text-slate-500">
                          {formatDate(record.calculatedAt)}
                        </span>
                      </div>
                      
                      <div className="font-mono text-slate-900">
                        {record.oldValue !== null ? `$${record.oldValue.toFixed(6)}` : 'Not set'}
                        {' → '}
                        <span className="font-semibold">${record.newValue.toFixed(6)}</span>
                      </div>
                      
                      {record.bomCode && (
                        <div className="text-xs text-slate-600 mt-1">
                          BOM: {record.bomCode} (v{record.versionNumber})
                        </div>
                      )}
                      
                      {record.componentSnapshot && record.componentSnapshot.length > 0 && (
                        <details className="mt-2">
                          <summary className="text-xs text-blue-600 cursor-pointer hover:text-blue-700">
                            Show {record.componentSnapshot.length} components
                          </summary>
                          <div className="mt-2 space-y-1 pl-4 border-l-2 border-slate-200">
                            {record.componentSnapshot.map((comp, idx) => (
                              <div key={idx} className="text-xs text-slate-700">
                                <span className="font-mono">{comp.componentSku}</span>
                                {' - '}
                                {comp.quantityPer} {comp.uom} @ ${comp.unitCost.toFixed(6)}
                                {' = '}
                                <span className="font-semibold">${comp.extendedCost.toFixed(6)}</span>
                                {comp.scrapFactor && comp.scrapFactor > 0 && (
                                  <span className="text-slate-500"> (scrap: {(comp.scrapFactor * 100).toFixed(1)}%)</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Confirmation Modal */}
      <Modal
        isOpen={showConfirmRoll}
        onClose={() => setShowConfirmRoll(false)}
        title="Recalculate Rolled Cost"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            This will calculate the rolled cost for <strong>{itemSku} - {itemName}</strong> based on the active BOM and current component costs.
          </p>
          
          <p className="text-sm text-slate-700">
            The calculation will be recorded in the cost history with a snapshot of all component costs.
          </p>
          
          {isStale && (
            <Alert
              variant="warning"
              title="Current cost is stale"
              message="Component costs have changed. This recalculation will update to current values."
            />
          )}
          
          <div className="flex gap-2 justify-end">
            <Button
              variant="secondary"
              onClick={() => setShowConfirmRoll(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => rollMutation.mutate()}
              disabled={rollMutation.isPending}
            >
              {rollMutation.isPending ? 'Calculating...' : 'Recalculate'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Preview Modal */}
      <Modal
        isOpen={showPreview}
        onClose={() => setShowPreview(false)}
        title="Cost Breakdown Preview"
      >
        <div className="space-y-4">
          {previewQuery.isLoading && <LoadingSpinner label="Loading preview..." />}
          
          {previewQuery.isError && (
            <Alert
              variant="error"
              title="Failed to load preview"
              message={(previewQuery.error as unknown as ApiError).message}
            />
          )}
          
          {previewQuery.data && (
            <>
              <div className="bg-slate-50 rounded-lg p-4">
                <div className="text-sm text-slate-600 mb-1">Total Rolled Cost</div>
                <div className="font-mono text-2xl font-bold text-slate-900">
                  ${previewQuery.data.totalCost.toFixed(6)}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Based on {previewQuery.data.componentCount} components
                </div>
              </div>
              
              <div>
                <h4 className="text-sm font-semibold text-slate-900 mb-2">Component Breakdown</h4>
                <div className="space-y-2">
                  {previewQuery.data.components.map((comp, idx) => (
                    <div
                      key={idx}
                      className="border border-slate-200 rounded p-3 text-sm"
                    >
                      <div className="flex justify-between items-start gap-4">
                        <div className="flex-1">
                          <div className="font-semibold text-slate-900">{comp.sku}</div>
                          <div className="text-slate-600">{comp.name}</div>
                          <div className="text-xs text-slate-500 mt-1">
                            {comp.quantityPer} {comp.uom} × ${comp.unitCost.toFixed(6)}
                            {comp.scrapFactor > 0 && ` × (1 + ${(comp.scrapFactor * 100).toFixed(1)}% scrap)`}
                          </div>
                        </div>
                        <div className="font-mono font-semibold text-slate-900">
                          ${comp.extendedCost.toFixed(6)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  )
}
