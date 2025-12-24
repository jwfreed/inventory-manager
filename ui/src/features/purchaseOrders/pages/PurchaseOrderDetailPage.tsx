import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import {
  approvePurchaseOrder,
  deletePurchaseOrderApi,
  updatePurchaseOrder,
} from '../api/purchaseOrders'
import type { ApiError } from '../../../api/types'
import { Section } from '../../../components/Section'
import { Card } from '../../../components/Card'
import { LoadingSpinner } from '../../../components/Loading'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Badge } from '../../../components/Badge'
import { Input, Textarea } from '../../../components/Inputs'
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useState } from 'react'
import { SearchableSelect } from '../../../components/SearchableSelect'
import { useLocationsList } from '../../locations/queries'
import { usePurchaseOrder } from '../queries'
import { formatDate } from '../../../lib/formatters'

export default function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [orderDate, setOrderDate] = useState('')
  const [expectedDate, setExpectedDate] = useState('')
  const [shipToLocationId, setShipToLocationId] = useState('')
  const [receivingLocationId, setReceivingLocationId] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [vendorReference, setVendorReference] = useState('')
  const [notes, setNotes] = useState('')
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [submitMessage, setSubmitMessage] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [approveMessage, setApproveMessage] = useState<string | null>(null)
  const [approveError, setApproveError] = useState<string | null>(null)
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false)

  const normalizeDateInput = (value?: string | null) => {
    if (!value) return ''
    // Support either a date-only string ("YYYY-MM-DD") or an ISO timestamp.
    if (value.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      return value.slice(0, 10)
    }
    return ''
  }

  const formatFieldErrors = (details: unknown): string | null => {
    if (!details || typeof details !== 'object') return null
    const error = (details as { error?: { fieldErrors?: Record<string, string[]> } }).error
    const fieldErrors = error?.fieldErrors
    if (!fieldErrors) return null
    const parts = Object.entries(fieldErrors).flatMap(([field, messages]) =>
      (messages ?? []).map((message) => `${field}: ${message}`),
    )
    return parts.length ? parts.join(' ') : null
  }

  const formatError = (err: unknown, fallback: string): string => {
    if (!err) return fallback
    if (typeof err === 'string') return err
    if (err instanceof Error && err.message) return err.message
    const apiErr = err as ApiError
    const fieldMessage = formatFieldErrors(apiErr?.details)
    if (fieldMessage) return fieldMessage
    if (apiErr?.message && typeof apiErr.message === 'string') return apiErr.message
    try {
      return JSON.stringify(err)
    } catch {
      return fallback
    }
  }

  const poQuery = usePurchaseOrder(id)

  const locationsQuery = useLocationsList({ limit: 200, active: true }, { staleTime: 60_000, retry: 1 })

  const locationOptions = useMemo(
    () =>
      (locationsQuery.data?.data ?? []).map((loc) => ({
        value: loc.id,
        label: `${loc.code} — ${loc.name}`,
        keywords: `${loc.code} ${loc.name} ${loc.type}`,
      })),
    [locationsQuery.data],
  )

  useEffect(() => {
    if (!poQuery.data) return
    setOrderDate(normalizeDateInput(poQuery.data.orderDate))
    setExpectedDate(normalizeDateInput(poQuery.data.expectedDate))
    setShipToLocationId(poQuery.data.shipToLocationId ?? '')
    setReceivingLocationId(poQuery.data.receivingLocationId ?? '')
    setStatus(poQuery.data.status ?? 'draft')
    setVendorReference(poQuery.data.vendorReference ?? '')
    setNotes(poQuery.data.notes ?? '')
  }, [poQuery.data])

  useEffect(() => {
    if (!poQuery.data?.status) return
    setStatus(poQuery.data.status)
  }, [poQuery.data?.status])

  useEffect(() => {
    if (status !== 'draft') {
      setShowSubmitConfirm(false)
    }
  }, [status])

  const updateMutation = useMutation({
    mutationFn: () =>
      updatePurchaseOrder(id as string, {
        orderDate: normalizeDateInput(orderDate) || undefined,
        expectedDate: normalizeDateInput(expectedDate) || undefined,
        shipToLocationId: shipToLocationId || undefined,
        receivingLocationId: receivingLocationId || undefined,
        vendorReference: vendorReference.trim() || undefined,
        status: status ?? poQuery.data?.status ?? 'draft',
        notes: notes || undefined,
      }),
    onSuccess: () => {
      setSaveError(null)
      setSaveMessage('Draft saved. This PO is still unsubmitted.')
      void poQuery.refetch()
    },
    onError: (err: ApiError | unknown) => {
      setSaveMessage(null)
      setSaveError(formatError(err, 'Save failed. Check required fields and try again.'))
    },
  })

  const submitMutation = useMutation({
    mutationFn: () =>
      updatePurchaseOrder(id as string, {
        orderDate: normalizeDateInput(orderDate) || undefined,
        expectedDate: normalizeDateInput(expectedDate) || undefined,
        shipToLocationId: shipToLocationId || undefined,
        receivingLocationId: receivingLocationId || undefined,
        vendorReference: vendorReference.trim() || undefined,
        status: 'submitted',
        notes: notes || undefined,
      }),
    onSuccess: (updated) => {
      const statusValue = updated.status ?? 'submitted'
      const submittedOn = formatDate(updated.updatedAt ?? new Date())
      const message =
        statusValue === 'approved'
          ? `Approved on ${submittedOn}. This PO is authorized for receiving.`
          : `Submitted on ${submittedOn}. Awaiting approval before receiving.`
      setStatus(statusValue)
      setSubmitError(null)
      setSubmitMessage(message)
      setSaveMessage(null)
      setSaveError(null)
      setShowSubmitConfirm(false)
      void poQuery.refetch()
    },
    onError: (err: ApiError | unknown) => {
      setSubmitMessage(null)
      setSubmitError(formatError(err, 'Submission failed. Check required fields and try again.'))
    },
  })

  const approveMutation = useMutation({
    mutationFn: () => approvePurchaseOrder(id as string),
    onSuccess: (updated) => {
      const approvedOn = formatDate(updated.updatedAt ?? new Date())
      setStatus(updated.status ?? 'approved')
      setApproveError(null)
      setApproveMessage(`Approved on ${approvedOn}. This PO is authorized for receiving.`)
      setSubmitMessage(null)
      setSubmitError(null)
      void poQuery.refetch()
    },
    onError: (err: ApiError | unknown) => {
      setApproveMessage(null)
      setApproveError(formatError(err, 'Approval failed. Check the PO status and try again.'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deletePurchaseOrderApi(id as string),
    onSuccess: () => {
      navigate('/purchase-orders')
    },
  })

  if (poQuery.isLoading) {
    return (
      <Section title="Purchase Order">
        <Card>
          <LoadingSpinner label="Loading PO..." />
        </Card>
      </Section>
    )
  }

  if (poQuery.isError || !poQuery.data) {
    return (
      <Section title="Purchase Order">
        <Card>
          <Alert variant="error" title="Error" message={(poQuery.error as ApiError)?.message ?? 'PO not found'} />
        </Card>
      </Section>
    )
  }

  const po = poQuery.data
  const statusKey = (status || po.status || 'draft').toLowerCase()
  const isSubmitted = statusKey === 'submitted'
  const canReceive = statusKey === 'approved' || statusKey === 'partially_received'
  const statusMeta: Record<
    string,
    { label: string; variant: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; dot: string; helper: string }
  > = {
    draft: {
      label: 'Draft',
      variant: 'warning',
      dot: 'bg-amber-500',
      helper: 'Editable. Not yet committed.',
    },
    submitted: {
      label: 'Submitted',
      variant: 'info',
      dot: 'bg-sky-500',
      helper: 'Locked. Awaiting approval.',
    },
    approved: {
      label: 'Approved',
      variant: 'success',
      dot: 'bg-emerald-500',
      helper: 'Authorized. Ready for receiving.',
    },
    partially_received: {
      label: 'Partially received',
      variant: 'info',
      dot: 'bg-sky-500',
      helper: 'Receiving in progress.',
    },
    received: {
      label: 'Received',
      variant: 'info',
      dot: 'bg-sky-500',
      helper: 'Locked. Receiving complete.',
    },
    closed: {
      label: 'Closed',
      variant: 'neutral',
      dot: 'bg-slate-400',
      helper: 'Locked. Closed out.',
    },
  }
  const currentStatus =
    statusMeta[statusKey] ?? {
      label: statusKey,
      variant: 'neutral',
      dot: 'bg-slate-400',
      helper: 'Locked.',
    }
  const isEditable = statusKey === 'draft'
  const isLocked = !isEditable
  const poLines = po.lines ?? []
  const hasLines = poLines.length > 0
  const quantitiesValid = hasLines && poLines.every((line) => (line.quantityOrdered ?? 0) > 0)
  const checklist = [
    { id: 'vendor', label: 'Vendor selected', ok: Boolean(po.vendorId) },
    { id: 'lines', label: 'At least one line item', ok: hasLines },
    { id: 'qty', label: 'Quantities valid', ok: quantitiesValid },
    { id: 'shipTo', label: 'Ship-to location set', ok: Boolean(shipToLocationId) },
    { id: 'receiving', label: 'Receiving/staging set', ok: Boolean(receivingLocationId) },
    { id: 'expected', label: 'Expected date set', ok: Boolean(normalizeDateInput(expectedDate)) },
  ]
  const missingChecklist = checklist.filter((item) => !item.ok).map((item) => item.label)
  const isReadyToSubmit = missingChecklist.length === 0
  const isBusy =
    updateMutation.isPending || submitMutation.isPending || approveMutation.isPending || deleteMutation.isPending

  const handleSave = () => {
    setSaveMessage(null)
    setSaveError(null)
    setSubmitMessage(null)
    setSubmitError(null)
    setApproveMessage(null)
    setApproveError(null)
    updateMutation.mutate()
  }

  const handleSubmitIntent = () => {
    setSaveMessage(null)
    setSaveError(null)
    setSubmitMessage(null)
    setSubmitError(null)
    setApproveMessage(null)
    setApproveError(null)
    if (!isReadyToSubmit) {
      setSubmitError(`Complete required items before submitting: ${missingChecklist.join(', ')}.`)
      return
    }
    setShowSubmitConfirm(true)
  }

  const handleSubmitConfirm = () => {
    setSubmitMessage(null)
    setSubmitError(null)
    setApproveMessage(null)
    setApproveError(null)
    submitMutation.mutate()
  }

  const handleApprove = () => {
    setApproveMessage(null)
    setApproveError(null)
    setSubmitMessage(null)
    setSubmitError(null)
    approveMutation.mutate()
  }

  return (
    <div className="space-y-4">
      <Section title={`Purchase Order ${po.poNumber}`} description="Full details and lines.">
        <Card>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="text-sm text-slate-700">
              <div className="font-medium">
                Vendor: {po.vendorCode ?? po.vendorId} {po.vendorName ? `— ${po.vendorName}` : ''}
              </div>
              <div className="text-xs text-slate-500">PO {po.poNumber}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
              <div className="mt-1 flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${currentStatus.dot}`} aria-hidden="true" />
                <Badge variant={currentStatus.variant}>{currentStatus.label}</Badge>
              </div>
              <div className="mt-1 text-xs text-slate-600">{currentStatus.helper}</div>
            </div>
          </div>
          {(isLocked || submitError || saveError || submitMessage || saveMessage) && (
            <div className="mt-3 space-y-2">
              {isLocked && (
                <Alert
                  variant="info"
                  title="Locked"
                  message={`This PO is ${currentStatus.label.toLowerCase()} and read-only. Use Repeat to create a new draft if changes are needed.`}
                />
              )}
              {submitError && <Alert variant="error" title="Submission failed" message={submitError} />}
              {approveError && <Alert variant="error" title="Approval failed" message={approveError} />}
              {saveError && <Alert variant="error" title="Save failed" message={saveError} />}
              {submitMessage && (
                <Alert
                  variant="success"
                  title={statusKey === 'approved' ? 'PO approved' : 'PO submitted'}
                  message={submitMessage}
                  action={
                    canReceive ? (
                      <Link to="/receiving">
                        <Button size="sm" variant="secondary">
                          Go to Receiving
                        </Button>
                      </Link>
                    ) : undefined
                  }
                />
              )}
              {approveMessage && (
                <Alert
                  variant="success"
                  title="PO approved"
                  message={approveMessage}
                  action={
                    <Link to="/receiving">
                      <Button size="sm" variant="secondary">
                        Go to Receiving
                      </Button>
                    </Link>
                  }
                />
              )}
              {saveMessage && <Alert variant="success" title="Draft saved" message={saveMessage} />}
            </div>
          )}
          <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-3 text-sm text-slate-800">
            <div>
              <div className="text-xs uppercase text-slate-500">PO Number</div>
              <div className="font-semibold">{po.poNumber}</div>
            </div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase text-slate-500">Order date</span>
              <Input
                type="date"
                value={orderDate}
                onChange={(e) => setOrderDate(e.target.value)}
                disabled={isLocked || isBusy}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase text-slate-500">Expected date</span>
              <Input
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
                disabled={isLocked || isBusy}
              />
            </label>
            <div>
              <SearchableSelect
                label="Ship-to"
                value={shipToLocationId}
                options={locationOptions}
                disabled={locationsQuery.isLoading || isLocked || isBusy}
                onChange={(nextValue) => setShipToLocationId(nextValue)}
              />
            </div>
            <div>
              <SearchableSelect
                label="Receiving/staging"
                value={receivingLocationId}
                options={locationOptions}
                disabled={locationsQuery.isLoading || isLocked || isBusy}
                onChange={(nextValue) => setReceivingLocationId(nextValue)}
              />
            </div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase text-slate-500">Vendor reference</span>
              <Input
                value={vendorReference}
                onChange={(e) => setVendorReference(e.target.value)}
                placeholder="Optional"
                disabled={isLocked || isBusy}
              />
            </label>
          </div>
          <label className="mt-3 block space-y-1 text-sm">
            <span className="text-xs uppercase text-slate-500">Notes</span>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={isLocked || isBusy} />
          </label>
          {isEditable && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs uppercase tracking-wide text-slate-500">Ready to submit</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {checklist.map((item) => (
                  <div
                    key={item.id}
                    className={`flex items-center justify-between rounded-md border px-2 py-1 text-sm ${
                      item.ok ? 'border-green-200 bg-white text-slate-700' : 'border-amber-200 bg-amber-50 text-amber-900'
                    }`}
                  >
                    <span>{item.label}</span>
                    <span className={`text-xs font-semibold uppercase ${item.ok ? 'text-green-700' : 'text-amber-700'}`}>
                      {item.ok ? 'Ready' : 'Missing'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {isEditable && showSubmitConfirm && (
            <div className="mt-3">
              <Alert
                variant="warning"
                title="Confirm submission"
                message="Submitting locks this PO and sends it for approval. You can still view it, but edits are disabled."
                action={
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSubmitConfirm} disabled={submitMutation.isPending}>
                      {submitMutation.isPending ? 'Submitting…' : 'Confirm submit'}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setShowSubmitConfirm(false)}
                      disabled={submitMutation.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                }
              />
            </div>
          )}
          {isSubmitted && (
            <div className="mt-3">
              <Alert
                variant="warning"
                title="Awaiting approval"
                message="This PO must be approved before receiving can begin."
                action={
                  <Button size="sm" onClick={handleApprove} disabled={approveMutation.isPending || isBusy}>
                    {approveMutation.isPending ? 'Approving…' : 'Approve PO'}
                  </Button>
                }
              />
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {isEditable && (
              <Button size="sm" onClick={handleSubmitIntent} disabled={!isReadyToSubmit || isBusy}>
                {submitMutation.isPending ? 'Submitting…' : 'Submit PO for approval'}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={handleSave} disabled={isLocked || isBusy}>
              {updateMutation.isPending ? 'Saving…' : 'Save draft'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (confirm('Delete this purchase order?')) {
                  deleteMutation.mutate()
                }
              }}
              disabled={isBusy}
            >
              Delete
            </Button>
            <Link to="/purchase-orders">
              <Button variant="secondary" size="sm">
                Back to list
              </Button>
            </Link>
            <Link to="/purchase-orders/new">
              <Button variant="secondary" size="sm">
                New PO
              </Button>
            </Link>
          </div>
        </Card>
      </Section>

      <Section title="Lines">
        <Card>
          <div className="mb-3 text-xs text-slate-500">
            Ordered vs received/in-transit is not surfaced yet in this UI; use Receiving/Putaway to verify what has arrived.
          </div>
          {po.lines && po.lines.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Line</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Item</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Qty</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">UOM</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {po.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="px-3 py-2 text-sm text-slate-800">{line.lineNumber}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">
                        {line.itemSku ?? line.itemId}
                        {line.itemName ? ` — ${line.itemName}` : ''}
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-800">{line.quantityOrdered}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">{line.uom}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">{line.notes ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-4 text-sm text-slate-600">No lines.</div>
          )}
        </Card>
      </Section>
    </div>
  )
}
