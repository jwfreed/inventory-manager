import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  approvePurchaseOrder,
  closePurchaseOrder,
  closePurchaseOrderLine,
  cancelPurchaseOrderApi,
  updatePurchaseOrder,
} from '../api/purchaseOrders'
import type { ApiError } from '@api/types'
import { Alert, Button, Card, LoadingSpinner, Modal, Section } from '@shared/ui'
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useState } from 'react'
import { useLocationsList } from '@features/locations/queries'
import { usePurchaseOrder } from '../queries'
import { formatDate } from '@shared/formatters'
import { PurchaseOrderLinesTable } from '../components/PurchaseOrderLinesTable'
import { PurchaseOrderStatusHeader } from '../components/PurchaseOrderStatusHeader'
import { PurchaseOrderAlerts } from '../components/PurchaseOrderAlerts'
import { PurchaseOrderDetailsForm } from '../components/PurchaseOrderDetailsForm'
import { PurchaseOrderChecklistPanel } from '../components/PurchaseOrderChecklistPanel'
import { PurchaseOrderActionBar } from '../components/PurchaseOrderActionBar'
import { PurchaseOrderCloseModal } from '../components/PurchaseOrderCloseModal'
import { useAuditLog } from '../../audit/queries'
import { AuditTrailTable } from '../../audit/components/AuditTrailTable'
import {
  canClosePurchaseOrderHeader,
  canClosePurchaseOrderLine as canClosePurchaseOrderLinePolicy,
  getPurchaseOrderHeaderCloseOptions,
} from '../lib/purchaseOrderClosePolicy'

function AuditTrailPanel({ entityId }: { entityId?: string }) {
  const auditQuery = useAuditLog(
    { entityType: 'purchase_order', entityId: entityId ?? '', limit: 50, offset: 0 },
    { enabled: Boolean(entityId) },
  )

  return (
    <Section title="Audit trail" subtitle="Authoritative history of key actions.">
      <Card>
        {auditQuery.isLoading && <LoadingSpinner label="Loading audit trail..." />}
        {auditQuery.isError && (
          <Alert
            variant="error"
            title="Audit trail unavailable"
            message={(auditQuery.error as ApiError)?.message ?? 'Could not load audit trail.'}
          />
        )}
        {!auditQuery.isLoading && !auditQuery.isError && <AuditTrailTable entries={auditQuery.data ?? []} />}
      </Card>
    </Section>
  )
}

export default function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
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
  const [closeMessage, setCloseMessage] = useState<string | null>(null)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [showHeaderCloseModal, setShowHeaderCloseModal] = useState(false)
  const [lineToClose, setLineToClose] = useState<string | null>(null)

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

  const cancelMutation = useMutation({
    mutationFn: () => cancelPurchaseOrderApi(id as string),
    onSuccess: async (updated) => {
      setShowCancelConfirm(false)
      setCloseError(null)
      setCloseMessage('Purchase order canceled.')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['purchase-orders'] }),
        poQuery.refetch(),
      ])
    },
    onError: (err: ApiError | unknown) => {
      setCloseMessage(null)
      setCloseError(formatError(err, 'Cancel failed. Check the PO status and try again.'))
    },
  })

  const headerCloseMutation = useMutation({
    mutationFn: (payload: { closeAs: 'closed' | 'cancelled'; reason: string; notes?: string }) =>
      closePurchaseOrder(id as string, payload),
    onSuccess: async (updated) => {
      setShowHeaderCloseModal(false)
      setCloseError(null)
      setCloseMessage('Purchase order closed.')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['purchase-orders'] }),
        poQuery.refetch(),
      ])
    },
    onError: (err: ApiError | unknown) => {
      setCloseMessage(null)
      setCloseError(formatError(err, 'Purchase order close failed.'))
    },
  })

  const lineCloseMutation = useMutation({
    mutationFn: (payload: { lineId: string; closeAs: 'short' | 'cancelled'; reason: string; notes?: string }) =>
      closePurchaseOrderLine(payload.lineId, {
        closeAs: payload.closeAs,
        reason: payload.reason,
        notes: payload.notes,
      }),
    onSuccess: async (result) => {
      setLineToClose(null)
      setCloseError(null)
      setCloseMessage('Purchase order line closed.')
      queryClient.setQueryData(['purchase-orders', 'detail', id as string], result.purchaseOrder)
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
    },
    onError: (err: ApiError | unknown) => {
      setCloseMessage(null)
      setCloseError(formatError(err, 'Purchase order line close failed.'))
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
    canceled: {
      label: 'Canceled',
      variant: 'danger',
      dot: 'bg-red-500',
      helper: 'Canceled. No longer actionable.',
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
  const isCancelable = ['draft', 'submitted', 'approved'].includes(statusKey)
  const canCloseHeader = canClosePurchaseOrderHeader(po)
  const headerCloseOptions = getPurchaseOrderHeaderCloseOptions(po).map((option) => ({
    value: option,
    label: option === 'closed' ? 'Closed' : 'Cancelled',
  }))
  const poLines = po.lines ?? []
  const lineCloseTarget = poLines.find((line) => line.id === lineToClose) ?? null
  const hasLines = poLines.length > 0
  const quantitiesValid = hasLines && poLines.every((line) => (line.quantityOrdered ?? 0) > 0)
  const checklist = [
    { id: 'vendor', label: 'Supplier selected', ok: Boolean(po.vendorId) },
    { id: 'lines', label: 'At least one line item', ok: hasLines },
    { id: 'qty', label: 'Quantities valid', ok: quantitiesValid },
    { id: 'shipTo', label: 'Ship-to location set', ok: Boolean(shipToLocationId) },
    { id: 'receiving', label: 'Receiving/staging set', ok: Boolean(receivingLocationId) },
    { id: 'expected', label: 'Expected date set', ok: Boolean(normalizeDateInput(expectedDate)) },
  ]
  const missingChecklist = checklist.filter((item) => !item.ok).map((item) => item.label)
  const isReadyToSubmit = missingChecklist.length === 0
  const isBusy =
    updateMutation.isPending ||
    submitMutation.isPending ||
    approveMutation.isPending ||
    cancelMutation.isPending ||
    headerCloseMutation.isPending ||
    lineCloseMutation.isPending

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
          <PurchaseOrderStatusHeader
            vendorLabel={`${po.vendorCode ?? po.vendorId}${po.vendorName ? ` — ${po.vendorName}` : ''}`}
            poNumber={po.poNumber}
            status={currentStatus}
          />
          <PurchaseOrderAlerts
            isLocked={isLocked}
            statusLabel={currentStatus.label}
            canReceive={canReceive}
            submitError={submitError}
            approveError={approveError}
            saveError={saveError}
            closeError={closeError}
            submitMessage={submitMessage}
            approveMessage={approveMessage}
            saveMessage={saveMessage}
            closeMessage={closeMessage}
          />
          <PurchaseOrderDetailsForm
            poNumber={po.poNumber}
            orderDate={orderDate}
            expectedDate={expectedDate}
            shipToLocationId={shipToLocationId}
            receivingLocationId={receivingLocationId}
            vendorReference={vendorReference}
            notes={notes}
            locationOptions={locationOptions}
            locationsLoading={locationsQuery.isLoading}
            isLocked={isLocked}
            isBusy={isBusy}
            onOrderDateChange={setOrderDate}
            onExpectedDateChange={setExpectedDate}
            onShipToChange={setShipToLocationId}
            onReceivingChange={setReceivingLocationId}
            onVendorReferenceChange={setVendorReference}
            onNotesChange={setNotes}
          />
          <PurchaseOrderChecklistPanel visible={isEditable} items={checklist} />
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
          <PurchaseOrderActionBar
            isEditable={isEditable}
            isReadyToSubmit={isReadyToSubmit}
            isLocked={isLocked}
            isBusy={isBusy}
            submitPending={submitMutation.isPending}
            savePending={updateMutation.isPending}
            canCancel={isCancelable}
            canClose={canCloseHeader}
            onSubmitIntent={handleSubmitIntent}
            onSave={handleSave}
            onCancelRequest={() => {
              if (!isCancelable) return
              setCloseMessage(null)
              setCloseError(null)
              setShowCancelConfirm(true)
            }}
            onCloseRequest={() => {
              if (!canCloseHeader) return
              setCloseMessage(null)
              setCloseError(null)
              setShowHeaderCloseModal(true)
            }}
          />
        </Card>
      </Section>

      <Section title="Lines">
        <Card>
          <div className="mb-3 text-xs text-slate-500">
            Ordered vs received/in-transit is not surfaced yet in this UI; use Receiving/Putaway to verify what has arrived.
          </div>
          <PurchaseOrderLinesTable
            lines={po.lines ?? []}
            canCloseLine={(line) => canClosePurchaseOrderLinePolicy(po, line)}
            closingLineId={lineCloseMutation.isPending ? lineToClose : null}
            onCloseLineRequest={(line) => {
              setCloseMessage(null)
              setCloseError(null)
              setLineToClose(line.id)
            }}
          />
        </Card>
      </Section>

      <AuditTrailPanel entityId={id} />

      <Modal
        isOpen={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        title="Cancel purchase order?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowCancelConfirm(false)}>
              Keep PO
            </Button>
            <Button size="sm" variant="danger" onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending}>
              {cancelMutation.isPending ? 'Canceling...' : 'Confirm cancel'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-slate-700">
          <p>This permanently cancels the purchase order from the UI workflow.</p>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            {po.poNumber}
          </div>
        </div>
      </Modal>

      <PurchaseOrderCloseModal
        isOpen={showHeaderCloseModal}
        title="Close purchase order"
        description="Choose how to close this purchase order. Cancelled is only available when no receipt activity exists."
        closeAsOptions={headerCloseOptions}
        confirmLabel="Confirm close"
        isPending={headerCloseMutation.isPending}
        onClose={() => setShowHeaderCloseModal(false)}
        onConfirm={(payload) =>
          headerCloseMutation.mutate({
            closeAs: payload.closeAs as 'closed' | 'cancelled',
            reason: payload.reason,
            notes: payload.notes,
          })
        }
      />

      <PurchaseOrderCloseModal
        isOpen={Boolean(lineCloseTarget)}
        title="Close PO line"
        description="Close the selected line as short or cancelled."
        closeAsOptions={
          statusKey === 'partially_received' || (lineCloseTarget?.quantityReceived ?? 0) > 0
            ? [{ value: 'short', label: 'Short' }]
            : [
                { value: 'short', label: 'Short' },
                { value: 'cancelled', label: 'Cancelled' },
              ]
        }
        confirmLabel="Confirm line close"
        isPending={lineCloseMutation.isPending}
        onClose={() => setLineToClose(null)}
        onConfirm={(payload) => {
          if (!lineToClose) return
          lineCloseMutation.mutate({
            lineId: lineToClose,
            closeAs: payload.closeAs as 'short' | 'cancelled',
            reason: payload.reason,
            notes: payload.notes,
          })
        }}
      />
    </div>
  )
}
