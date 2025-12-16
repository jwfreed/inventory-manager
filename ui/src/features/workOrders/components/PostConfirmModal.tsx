import { Modal } from '../../../components/Modal'
import { Button } from '../../../components/Button'

type Props = {
  isOpen: boolean
  title: string
  body: string
  preview: React.ReactNode
  onConfirm: () => void
  onCancel: () => void
}

export function PostConfirmModal({ isOpen, title, body, preview, onConfirm, onCancel }: Props) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm}>
            Confirm post
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-700">{body}</p>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">{preview}</div>
      </div>
    </Modal>
  )
}
