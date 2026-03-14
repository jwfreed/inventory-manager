import { useEffect, useState } from 'react'
import { Button, Input, Modal, Select, Textarea } from '@shared/ui'

type Option = {
  value: string
  label: string
}

type Props = {
  isOpen: boolean
  title: string
  description: string
  closeAsOptions: Option[]
  confirmLabel: string
  isPending?: boolean
  onClose: () => void
  onConfirm: (payload: { closeAs: string; reason: string; notes?: string }) => void
}

export function PurchaseOrderCloseModal({
  isOpen,
  title,
  description,
  closeAsOptions,
  confirmLabel,
  isPending = false,
  onClose,
  onConfirm,
}: Props) {
  const [closeAs, setCloseAs] = useState(closeAsOptions[0]?.value ?? '')
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setCloseAs(closeAsOptions[0]?.value ?? '')
    setReason('')
    setNotes('')
  }, [closeAsOptions, isOpen])

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onConfirm({ closeAs, reason: reason.trim(), notes: notes.trim() || undefined })}
            disabled={isPending || !closeAs || !reason.trim()}
          >
            {isPending ? 'Saving...' : confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-700">{description}</p>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Close as</span>
          <Select value={closeAs} onChange={(event) => setCloseAs(event.target.value)}>
            {closeAsOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Reason</span>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
      </div>
    </Modal>
  )
}
