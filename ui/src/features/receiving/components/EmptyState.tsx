import { MagnifyingGlassIcon, ClipboardDocumentCheckIcon, TruckIcon } from '@heroicons/react/24/outline'
import { Button } from '@shared/ui'

type EmptyStateVariant = 'no-receipts' | 'no-po-selected' | 'no-qc-lines' | 'no-putaway-lines'

type Props = {
  variant: EmptyStateVariant
  onAction?: () => void
  actionLabel?: string
}

const config: Record<EmptyStateVariant, {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  defaultActionLabel?: string
}> = {
  'no-receipts': {
    icon: MagnifyingGlassIcon,
    title: 'No receipts yet',
    description: 'Start by selecting a purchase order above and posting a receipt.',
    defaultActionLabel: undefined,
  },
  'no-po-selected': {
    icon: ClipboardDocumentCheckIcon,
    title: 'Select a purchase order',
    description: 'Choose a PO from the dropdown to begin receiving inventory.',
    defaultActionLabel: undefined,
  },
  'no-qc-lines': {
    icon: ClipboardDocumentCheckIcon,
    title: 'Load a receipt to start QC',
    description: 'Select a recent receipt or enter a receipt ID to begin quality classification.',
    defaultActionLabel: undefined,
  },
  'no-putaway-lines': {
    icon: TruckIcon,
    title: 'No putaway lines yet',
    description: 'Use "Use receipt lines" to auto-fill from accepted quantities, or add lines manually.',
    defaultActionLabel: 'Use receipt lines',
  },
}

export function EmptyState({ variant, onAction, actionLabel }: Props) {
  const { icon: Icon, title, description, defaultActionLabel } = config[variant]
  const finalActionLabel = actionLabel || defaultActionLabel

  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div className="rounded-full bg-slate-100 p-4 mb-4">
        <Icon className="w-8 h-8 text-slate-400" />
      </div>
      <h3 className="text-base font-semibold text-slate-900 mb-2">{title}</h3>
      <p className="text-sm text-slate-600 max-w-sm mb-4">{description}</p>
      {onAction && finalActionLabel && (
        <Button onClick={onAction} size="sm" variant="secondary">
          {finalActionLabel}
        </Button>
      )}
    </div>
  )
}
