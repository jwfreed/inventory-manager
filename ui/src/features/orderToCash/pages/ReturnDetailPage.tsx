import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createReturnReceipt } from '../api/returnReceipts'
import { orderToCashQueryKeys, useReturn, useReturnReceiptsList } from '../queries'
import type { ApiError } from '../../../api/types'
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  LoadingSpinner,
  PageHeader,
  Panel,
  Textarea,
} from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'
import { formatStatusLabel } from '@shared/ui'
import { formatReturnOperationError } from '../lib/returnOperationErrorMessaging'
import { logOperationalMutationFailure } from '../../../lib/operationalLogging'

function toLocalDateTimeInput(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16)
}

export default function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [receivedAt, setReceivedAt] = useState(toLocalDateTimeInput(new Date().toISOString()))
  const [receivedToLocationId, setReceivedToLocationId] = useState('')
  const [externalRef, setExternalRef] = useState('')
  const [notes, setNotes] = useState('')
  const [inventoryMovementId, setInventoryMovementId] = useState('')
  const [lineQuantities, setLineQuantities] = useState<Record<string, string>>({})
  const [receiptError, setReceiptError] = useState<string | null>(null)

  const query = useReturn(id)
  const receiptsQuery = useReturnReceiptsList({ limit: 100 }, { staleTime: 30_000 })

  useEffect(() => {
    const err = query.error as ApiError | undefined
    if (query.isError && err?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [query.isError, query.error, navigate])

  const linkedReceipts = useMemo(
    () =>
      (receiptsQuery.data?.data ?? [])
        .filter((receipt) => receipt.returnAuthorizationId === id)
        .sort((left, right) =>
          String(right.receivedAt ?? right.createdAt ?? right.id).localeCompare(
            String(left.receivedAt ?? left.createdAt ?? left.id),
          ),
        ),
    [id, receiptsQuery.data],
  )

  const createReceiptMutation = useMutation({
    mutationFn: async () => {
      if (!query.data) {
        throw new Error('Return authorization not loaded.')
      }
      const lines = (query.data.lines ?? [])
        .map((line) => ({
          line,
          quantityReceived: Number(lineQuantities[line.id] ?? 0),
        }))
        .filter(({ quantityReceived }) => Number.isFinite(quantityReceived) && quantityReceived > 0)

      if (!receivedToLocationId.trim()) {
        throw new Error('Received-to location ID is required.')
      }
      if (lines.length === 0) {
        throw new Error('Enter at least one received quantity before creating a return receipt.')
      }

      return createReturnReceipt({
        returnAuthorizationId: query.data.id,
        receivedAt: new Date(receivedAt).toISOString(),
        receivedToLocationId: receivedToLocationId.trim(),
        externalRef: externalRef.trim() || undefined,
        inventoryMovementId: inventoryMovementId.trim() || undefined,
        notes: notes.trim() || undefined,
        lines: lines.map(({ line, quantityReceived }) => ({
          returnAuthorizationLineId: line.id,
          itemId: line.itemId || '',
          uom: line.uom || '',
          quantityReceived,
          notes: line.notes || undefined,
        })),
      })
    },
    onSuccess: async (receipt) => {
      setReceiptError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.returns.detail(id ?? '') }),
        queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.returnReceipts.all }),
      ])
      navigate(`/return-receipts/${receipt.id}`)
    },
    onError: (err) => {
      logOperationalMutationFailure('returns', 'create-receipt', err, { returnAuthorizationId: id })
      setReceiptError(formatReturnOperationError(err, 'Failed to create return receipt.'))
    },
  })

  const copyId = async () => {
    if (!id) return
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Return authorization"
        subtitle="Authorize the return, then create receipt documents for the quantities physically received back into the warehouse."
        action={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate('/returns')}>
              Back to list
            </Button>
            <Button variant="secondary" size="sm" onClick={copyId}>
              Copy ID
            </Button>
          </div>
        }
      />

      {query.isLoading && <LoadingSpinner label="Loading return..." />}
      {query.isError && query.error && !query.isLoading && (
        <ErrorState error={query.error as ApiError} onRetry={() => void query.refetch()} />
      )}

      {query.data && !query.isError ? (
        <>
          <Panel
            title="Authorization state"
            description="Return authorizations document intent only. Receipt and disposition records link to movements only when the backend record carries an inventory movement id."
          >
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
                <div className="mt-2">
                  <Badge variant="neutral">{formatStatusLabel(query.data.status)}</Badge>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">RMA number</div>
                <div className="mt-2 text-sm text-slate-900">{query.data.rmaNumber || query.data.id}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Customer</div>
                <div className="mt-2 text-sm text-slate-900">{query.data.customerId || '—'}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Sales order</div>
                <div className="mt-2 text-sm text-slate-900">{query.data.salesOrderId || '—'}</div>
              </div>
            </div>
          </Panel>

          <Panel
            title="Create return receipt"
            description="Record what physically arrived back at the warehouse. This creates the receipt document; movement links appear only if the backend record already has a movement id."
          >
            {receiptError ? <Alert variant="error" title="Return receipt failed" message={receiptError} /> : null}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">Received at</span>
                <Input
                  type="datetime-local"
                  value={receivedAt}
                  onChange={(event) => setReceivedAt(event.target.value)}
                  disabled={createReceiptMutation.isPending}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">Received-to location ID</span>
                <Input
                  value={receivedToLocationId}
                  onChange={(event) => setReceivedToLocationId(event.target.value)}
                  disabled={createReceiptMutation.isPending}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">External reference</span>
                <Input
                  value={externalRef}
                  onChange={(event) => setExternalRef(event.target.value)}
                  placeholder="Optional"
                  disabled={createReceiptMutation.isPending}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">Linked movement ID</span>
                <Input
                  value={inventoryMovementId}
                  onChange={(event) => setInventoryMovementId(event.target.value)}
                  placeholder="Optional existing movement"
                  disabled={createReceiptMutation.isPending}
                />
              </label>
              <label className="block space-y-1 md:col-span-2 xl:col-span-4">
                <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                <Textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  disabled={createReceiptMutation.isPending}
                />
              </label>
            </div>
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Line
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Item
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      UOM
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Qty authorized
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Qty received
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {(query.data.lines ?? []).map((line) => (
                    <tr key={line.id}>
                      <td className="px-4 py-3 text-sm text-slate-800">{line.lineNumber ?? '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">{line.itemId || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">{line.uom || '—'}</td>
                      <td className="px-4 py-3 text-right text-sm text-slate-800">
                        {line.quantityAuthorized !== undefined ? formatNumber(line.quantityAuthorized) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Input
                          type="number"
                          min={0}
                          step="any"
                          value={lineQuantities[line.id] ?? ''}
                          onChange={(event) =>
                            setLineQuantities((current) => ({
                              ...current,
                              [line.id]: event.target.value,
                            }))
                          }
                          disabled={createReceiptMutation.isPending}
                          className="ml-auto w-28"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex justify-end">
              <Button onClick={() => createReceiptMutation.mutate()} disabled={createReceiptMutation.isPending}>
                {createReceiptMutation.isPending ? 'Creating receipt...' : 'Create return receipt'}
              </Button>
            </div>
          </Panel>

          <Panel title="Return receipts" description="Recent receipt documents linked to this return authorization.">
            {receiptsQuery.isLoading ? (
              <LoadingSpinner label="Loading return receipts..." />
            ) : receiptsQuery.isError ? (
              <Alert
                variant="error"
                title="Receipt history unavailable"
                message={receiptsQuery.error?.message ?? 'Failed to load return receipts.'}
              />
            ) : linkedReceipts.length === 0 ? (
              <EmptyState
                title="No return receipts yet"
                description="Create the first receipt above when returned inventory arrives."
              />
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Receipt
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Status
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Received at
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Movement
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {linkedReceipts.map((receipt) => (
                      <tr key={receipt.id}>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          <Link className="text-brand-700 hover:underline" to={`/return-receipts/${receipt.id}`}>
                            {receipt.id}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          <Badge variant="neutral">{formatStatusLabel(receipt.status)}</Badge>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          {receipt.receivedAt ? formatDate(receipt.receivedAt) : '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          {receipt.inventoryMovementId ? (
                            <Link
                              className="text-brand-700 hover:underline"
                              to={`/movements/${receipt.inventoryMovementId}`}
                            >
                              {receipt.inventoryMovementId}
                            </Link>
                          ) : (
                            'No linked movement'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  )
}
