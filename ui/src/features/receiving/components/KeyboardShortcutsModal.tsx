import { memo, type ReactNode } from 'react'
import { Card } from '@shared/ui'
import { SHORTCUTS, useEscapeKey } from '../hooks/useKeyboardShortcuts'

type ShortcutDef = {
  key: string
  label: string
  description: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  preventDefault?: boolean
}

type Props = {
  onClose: () => void
}

function ShortcutRow({ shortcut }: { shortcut: ShortcutDef }) {
  const modifiers: ReactNode[] = []

  if (shortcut.ctrl) {
    modifiers.push(
      <kbd key="ctrl" className="px-2 py-1 rounded text-xs font-mono bg-slate-100 text-slate-700 border border-slate-300 shadow-sm">
        Ctrl
      </kbd>,
      <span key="ctrl-plus" className="text-slate-400">+</span>
    )
  }
  if (shortcut.shift) {
    modifiers.push(
      <kbd key="shift" className="px-2 py-1 rounded text-xs font-mono bg-slate-100 text-slate-700 border border-slate-300 shadow-sm">
        Shift
      </kbd>,
      <span key="shift-plus" className="text-slate-400">+</span>
    )
  }
  if (shortcut.alt) {
    modifiers.push(
      <kbd key="alt" className="px-2 py-1 rounded text-xs font-mono bg-slate-100 text-slate-700 border border-slate-300 shadow-sm">
        Alt
      </kbd>,
      <span key="alt-plus" className="text-slate-400">+</span>
    )
  }

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-slate-50">
      <span className="text-sm text-slate-700">{shortcut.description}</span>
      <div className="flex items-center gap-1">
        {modifiers}
        <kbd className="px-2 py-1 rounded text-xs font-mono bg-slate-100 text-slate-700 border border-slate-300 shadow-sm">
          {shortcut.label.toUpperCase()}
        </kbd>
      </div>
    </div>
  )
}

export const KeyboardShortcutsModal = memo(({ onClose }: Props) => {
  useEscapeKey(onClose, true)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <Card
        className="max-w-2xl w-full max-h-[80vh] overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold text-slate-900">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-100 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-6">
          {/* Navigation */}
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-3">
              Navigation
            </h3>
            <div className="space-y-2">
              <ShortcutRow shortcut={SHORTCUTS.RECEIPT_PAGE} />
              <ShortcutRow shortcut={SHORTCUTS.QC_PAGE} />
              <ShortcutRow shortcut={SHORTCUTS.PUTAWAY_PAGE} />
              <ShortcutRow shortcut={SHORTCUTS.FOCUS_SEARCH} />
            </div>
          </section>

          {/* QC Actions */}
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-3">
              QC Actions
            </h3>
            <div className="space-y-2">
              <ShortcutRow shortcut={SHORTCUTS.ACCEPT} />
              <ShortcutRow shortcut={SHORTCUTS.HOLD} />
              <ShortcutRow shortcut={SHORTCUTS.REJECT} />
              <ShortcutRow shortcut={SHORTCUTS.NEXT} />
              <ShortcutRow shortcut={SHORTCUTS.PREVIOUS} />
            </div>
          </section>

          {/* Form Actions */}
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-3">
              Form Actions
            </h3>
            <div className="space-y-2">
              <ShortcutRow shortcut={SHORTCUTS.SAVE} />
              <ShortcutRow shortcut={SHORTCUTS.POST} />
            </div>
          </section>

          {/* General */}
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-3">
              General
            </h3>
            <div className="space-y-2">
              <ShortcutRow shortcut={SHORTCUTS.CLEAR} />
              <ShortcutRow shortcut={SHORTCUTS.HELP} />
            </div>
          </section>
        </div>

        <div className="mt-6 pt-4 border-t border-slate-200">
          <p className="text-sm text-slate-600">
            <strong>Tip:</strong> Press <kbd className="px-1.5 py-0.5 rounded text-xs font-mono bg-slate-100 border border-slate-300">?</kbd> anytime to view this help
          </p>
        </div>
      </Card>
    </div>
  )
})

KeyboardShortcutsModal.displayName = 'KeyboardShortcutsModal'

export default KeyboardShortcutsModal
