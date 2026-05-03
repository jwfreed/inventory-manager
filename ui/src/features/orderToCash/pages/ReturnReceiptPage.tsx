import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@shared/auth'
import { createReturnDisposition, postReturnDisposition } from '../api/returnDispositions'
import {
  orderToCashQueryKeys,
  useReturn,
  useReturnDispositionsList,
  useReturnReceipt,
} from '../queries'
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
  Select,
  Textarea,
} from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'
import { formatStatusLabel } from '@shared/ui'
import { formatReturnOperationError } from '../lib/returnOperationErrorMessaging'
import { logOperationalMutationFailure } from '../../../lib/operationalLogging'
import { createIdempotencyKey } from '../../../lib/idempotency'
import { postReturnReceipt } from '../api/returnReceipts'

function toLocalDateTimeInput(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16)
}

const dispositionOptions = ['restock', 'scrap', 'quarantine_hold'] as const

export default function ReturnReceiptPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const queryClient = useQueryClient()
  const [occurredAt, setOccurredAt] = useState(toLocalDateTimeInput(new Date().toISOString()))
  const [dispositionType, setDispositionType] = useState<(typeof dispositionOptions)[number]>('restock')
  const [fromLocationId, setFromLocationId] = useState('')
  const [toLocationId, setToLocationId] = useState('')
  const [notes, setNotes] = useState('')
  const [lineQuantities, setLineQuantities] = useState<Record<string, string>>({})
  const [receiptActionError, setReceiptActionError] = useState<string | null>(null)
  const [dispositionError, setDispositionError] = useState<string | null>(null)
  const [dispositionPostError, setDispositionPostError] = useState<string | null>(null)

  const receiptQuery = useReturnReceipt(id)
  const returnQuery = useReturn(receiptQuery.data?.returnAuthorizationId, {
    enabled: Boolean(receiptQuery.data?.returnAuthorizationId),
    staleTime: 30_000,
  })
  const dispositionsQuery = useReturnDispositionsList({ limit: 100 }, { staleTime: 30_000 })

  useEffect(() => {
    const err = receiptQuery.error as ApiError | undefined
    if (receiptQuery.isError && err?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [receiptQuery.isError, receiptQuery.error, navigate])

  useEffect(() => {
    if (!fromLocationId && receiptQuery.data?.receivedToLocationId) {
      setFromLocationId(receiptQuery.data.receivedToLocationId)
    }
  }, [fromLocationId, receiptQuery.data?.receivedToLocationId])

  const linkedDispositions = useMemo(
    () =>
      (dispositionsQuery.data?.data ?? [])
        .filter((disposition) => disposition.returnReceiptId === id)
        .sort((left, right) =>
          String(right.occurredAt ?? right.createdAt ?? right.id).localeCompare(
            String(left.occurredAt ?? left.createdAt ?? left.id),
          ),
        ),
    [dispositionsQuery.data, id],
  )

  const receiptIsPosted = receiptQuery.data?.status === 'posted'
  const dispositionCreationBlockedMessage = receiptIsPosted
    ? null
    : 'Post the receipt before creating disposition drafts.'

  const canWriteReturnReceipt = hasPermission('outbound:write') && !!receiptQuery.data
  const canCreateDisposition = hasPermission('outbound:write') && receiptIsPosted
  const canPostDisposition = hasPermission('outbound:write') && receiptIsPosted

  const handlePostReceipt = () => {
    if (!canWriteReturnReceipt || receiptIsPosted) return
    postReceiptMutation.mutate()
  }

  const handleCreateDisposition = () => {
    if (!canCreateDisposition) return
    createDispositionMutation.mutate()
  }

  const handlePostDisposition = (dispositionId: string) => {
    if (!canPostDisposition) return
    postDispositionMutation.mutate(dispositionId)
  }

  const postReceiptMutation = useMutation({
    mutationFn: async () => {
      if (!receiptQuery.data) {
        throw new Error('Return receipt not loaded.')
      }
      return postReturnReceipt(receiptQuery.data.id, createIdempotencyKey('return-receipt-post'))
    },
    onSuccess: async () => {
      setReceiptActionError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.returnReceipts.detail(id ?? '') }),
        queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.returnReceipts.all }),
      ])
    },
    onError: (err) => {
      logOperationalMutationFailure('returns', 'post-receipt', err, { returnReceiptId: id })
      setReceiptActionError(formatReturnOperationError(err, 'Failed to post return receipt.'))
    },
  })

  const postDispositionMutation = useMutation({
    mutationFn: async (dispositionId: string) =>
      postReturnDisposition(dispositionId, createIdempotencyKey('return-disposition-post')),
    onSuccess: async () => {
      setDispositionError(null)
      setDispositionPostError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.returnDispositions.all }),
        queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.returnReceipts.detail(id ?? '') }),
      ])
    },
    onError: (err) => {
      logOperationalMutationFailure('returns', 'post-disposition', err, { returnReceiptId: id })
      setDispositionPostError(formatReturnOperationError(err, 'Failed to post return disposition.'))
    },
  })

  const createDispositionMutation = useMutation({
    mutationFn: async () => {
      if (!receiptQuery.data) {
        throw new Error('Return receipt not loaded.')
      }
      if (!receiptIsPosted) {
        throw new Error('Post the receipt before creating disposition drafts.')
      }
      const lines = (receiptQuery.data.lines ?? [])
        .map((line, index) => ({
          line,
          lineNumber: index + 1,
          quantity: Number(lineQuantities[line.id] ?? 0),
        }))
        .filter(({ quantity }) => Number.isFinite(quantity) && quantity > 0)

      if (!fromLocationId.trim()) {
        throw new Error('From-location ID is required.')
      }
      if (!toLocationId.trim()) {
        throw new Error('To-location ID is required.')
      }
      if (lines.length === 0) {
        throw new Error('Enter at least one positive disposition quantity before continuing.')
      }

      return createReturnDisposition({
        returnReceiptId: receiptQuery.data.id,
        occurredAt: new Date(occurredAt).toISOString(),
        dispositionType,
        fromLocationId: fromLocationId.trim(),
        toLocationId: toLocationId.trim() || undefined,
        notes: notes.trim() || undefined,
        lines: lines.map(({ line, lineNumber, quantity }) => ({
          lineNumber,
          itemId: line.itemId || '',
          uom: line.uom || '',
          quantity,
          notes: line.notes || undefined,
        })),
      })
    },
    onSuccess: async () => {
      setDispositionError(null)
      setDispositionPostError(null)
      await queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.returnDispositions.all })
      await queryClient.invalidateQueries({ queryKey: orderToCashQueryKeys.returnReceipts.detail(id ?? '') })
    },
    onError: (err) => {
      logOperationalMutationFailure('returns', 'create-disposition', err, { returnReceiptId: id })
      setDispositionError(formatReturnOperationError(err, 'Failed to create return disposition.'))
    },
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Return receipt"
        subtitle="Review the received return lines, post the receipt, then create and post disposition drafts for restock, scrap, or quarantine handling."
        action={
          <div className="flex gap-2">
            {receiptQuery.data?.returnAuthorizationId ? (
              <Link to={`/returns/${receiptQuery.data.returnAuthorizationId}`}>
                <Button variant="secondary" size="sm">
                  Back to return
                </Button>
              </Link>
            ) : null}
            {returnQuery.data ? (
              <Link to={`/returns/${returnQuery.data.id}`}>
                <Button variant="secondary" size="sm">
                  Return authorization
                </Button>
              </Link>
            ) : null}
          </div>
        }
      />

      {receiptQuery.isLoading && <LoadingSpinner label="Loading return receipt..." />}
      {receiptQuery.isError && receiptQuery.error && !receiptQuery.isLoading && (
        <ErrorState error={receiptQuery.error as ApiError} onRetry={() => void receiptQuery.refetch()} />
      )}

      {receiptQuery.data && !receiptQuery.isError ? (
        <>
          <Panel
            title="Receipt state"
            description="This receipt is a draft until posted. Posting creates the authoritative inventory movement and unlocks disposition posting."
          >
            {receiptActionError ? <Alert variant="error" title="Receipt post failed" message={receiptActionError} /> : null}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
                <div className="mt-2">
                  <Badge variant={receiptIsPosted ? 'success' : 'neutral'}>
                    {formatStatusLabel(receiptQuery.data.status)}
                  </Badge>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Received at</div>
                <div className="mt-2 text-sm text-slate-900">
                  {receiptQuery.data.receivedAt ? formatDate(receiptQuery.data.receivedAt) : '—'}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Received-to location</div>
                <div className="mt-2 text-sm text-slate-900">{receiptQuery.data.receivedToLocationId || '—'}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Linked movement</div>
                <div className="mt-2 text-sm text-slate-900">
                  {receiptQuery.data.inventoryMovementId ? (
                    <Link
                      className="text-brand-700 hover:underline"
                      to={`/movements/${receiptQuery.data.inventoryMovementId}`}
                    >
                      {receiptQuery.data.inventoryMovementId}
                    </Link>
                  ) : (
                    'No linked movement'
                  )}
                </div>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <Button
                onClick={handlePostReceipt}
                disabled={receiptIsPosted || !canWriteReturnReceipt || postReceiptMutation.isPending}
              >
                {receiptIsPosted
                  ? 'Receipt posted'
                  : postReceiptMutation.isPending
                    ? 'Posting receipt...'
                    : 'Post receipt'}
              </Button>
            </div>
          </Panel>

          <Panel title="Receipt lines" description="Use the receipt lines as the source for disposition quantities.">
            {receiptQuery.data.lines && receiptQuery.data.lines.length > 0 ? (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Item
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        UOM
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Qty received
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {receiptQuery.data.lines.map((line) => (
                      <tr key={line.id}>
                        <td className="px-4 py-3 text-sm text-slate-800">{line.itemId || '—'}</td>
                        <td className="px-4 py-3 text-sm text-slate-800">{line.uom || '—'}</td>
                        <td className="px-4 py-3 text-right text-sm text-slate-800">
                          {line.quantityReceived !== undefined ? formatNumber(line.quantityReceived) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No receipt lines" description="No receipt lines were returned for this receipt." />
            )}
          </Panel>

          <Panel
            title="Disposition drafts"
            description="Create disposition drafts from the posted receipt, then post each draft explicitly when the outcome is final."
          >
            {!receiptIsPosted ? (
              <Alert
                variant="warning"
                title="Disposition locked"
                message={dispositionCreationBlockedMessage}
              />
            ) : null}
            {dispositionError ? (
              <Alert variant="error" title="Disposition failed" message={dispositionError} />
            ) : null}
            {dispositionPostError ? (
              <Alert variant="error" title="Disposition post failed" message={dispositionPostError} />
            ) : null}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">Occurred at</span>
                <Input
                  type="datetime-local"
                  value={occurredAt}
                  onChange={(event) => setOccurredAt(event.target.value)}
                  disabled={createDispositionMutation.isPending || !receiptIsPosted}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">Disposition type</span>
                <Select
                  value={dispositionType}
                  onChange={(event) =>
                    setDispositionType(event.target.value as (typeof dispositionOptions)[number])
                  }
                  disabled={createDispositionMutation.isPending || !receiptIsPosted}
                >
                  {dispositionOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">From-location ID</span>
                <Input
                  value={fromLocationId}
                  onChange={(event) => setFromLocationId(event.target.value)}
                  disabled={createDispositionMutation.isPending || !receiptIsPosted}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs uppercase tracking-wide text-slate-500">To-location ID</span>
                <Input
                  value={toLocationId}
                  onChange={(event) => setToLocationId(event.target.value)}
                  placeholder="Required destination"
                  disabled={createDispositionMutation.isPending || !receiptIsPosted}
                />
              </label>
              <label className="block space-y-1 md:col-span-2 xl:col-span-4">
                <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                <Textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  disabled={createDispositionMutation.isPending || !receiptIsPosted}
                />
              </label>
            </div>

            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Item
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      UOM
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Qty received
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Qty disposed
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {(receiptQuery.data.lines ?? []).map((line) => (
                    <tr key={line.id}>
                      <td className="px-4 py-3 text-sm text-slate-800">{line.itemId || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">{line.uom || '—'}</td>
                      <td className="px-4 py-3 text-right text-sm text-slate-800">
                        {line.quantityReceived !== undefined ? formatNumber(line.quantityReceived) : '—'}
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
                          disabled={createDispositionMutation.isPending || !receiptIsPosted}
                          className="ml-auto w-28"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex justify-end">
              <Button
                onClick={handleCreateDisposition}
                disabled={!canCreateDisposition || createDispositionMutation.isPending || !receiptIsPosted}
              >
                {createDispositionMutation.isPending
                  ? 'Creating disposition draft...'
                  : receiptIsPosted
                    ? 'Create disposition draft'
                    : 'Post receipt to unlock'}
              </Button>
            </div>
          </Panel>

          <Panel title="Linked dispositions" description="Recent disposition records linked to this receipt.">
            {dispositionsQuery.isLoading ? (
              <LoadingSpinner label="Loading dispositions..." />
            ) : dispositionsQuery.isError ? (
              <Alert
                variant="error"
                title="Dispositions unavailable"
                message={dispositionsQuery.error?.message ?? 'Failed to load dispositions.'}
              />
            ) : linkedDispositions.length === 0 ? (
              <EmptyState
                title="No dispositions yet"
                description={
                  receiptIsPosted
                    ? 'Record the first disposition above when the received material is triaged.'
                    : 'Post the receipt first to unlock disposition drafting.'
                }
              />
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Disposition
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Type
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Status
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Movement
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {linkedDispositions.map((disposition) => (
                      <tr key={disposition.id}>
                        <td className="px-4 py-3 text-sm text-slate-800">{disposition.id}</td>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          {formatStatusLabel(disposition.dispositionType)}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          <Badge variant={disposition.status === 'posted' ? 'success' : 'warning'}>
                            {formatStatusLabel(disposition.status)}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          {disposition.inventoryMovementId ? (
                            <Link
                              className="text-brand-700 hover:underline"
                              to={`/movements/${disposition.inventoryMovementId}`}
                            >
                              {disposition.inventoryMovementId}
                            </Link>
                          ) : (
                            'No linked movement'
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-800">
                          {disposition.status === 'draft' ? (
                            <div className="flex items-center gap-2">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => handlePostDisposition(disposition.id)}
                                disabled={!receiptIsPosted || !canPostDisposition || postDispositionMutation.isPending}
                              >
                                {receiptIsPosted
                                  ? postDispositionMutation.isPending
                                    ? 'Posting...'
                                    : 'Post disposition'
                                  : 'Receipt not posted'}
                              </Button>
                              {!receiptIsPosted ? (
                                <span className="text-xs text-slate-500">Post the receipt first.</span>
                              ) : null}
                            </div>
                          ) : (
                            <Badge variant="success">Posted</Badge>
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
