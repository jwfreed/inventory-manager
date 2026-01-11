import { memo } from 'react'
import { Card } from '@shared/ui'
import { SHORTCUTS } from '../hooks/useKeyboardShortcuts'

type Props = {
  onClose: () => void
}

export const KeyboardShortcutsModal = memo(({ onClose }: Props) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Card className="max-w-2xl w-full max-h-[80vh] overflow-y-auto">
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
}

function ShortcutRow({ shortcut }: { shortcut: typeof SHORTCUTS[keyof typeof SHORTCUTS] }) {
  const hasCtrl = 'ctrl' in shortcut && shortcut.ctrl
  const hasShift = 'shift' in shortcut && shortcut.shift
  const hasAlt = 'alt' in shortcut && shortcut.alt

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-slate-50">
      <span className="text-sm text-slate-700">{shortcut.description}</span>
      <div className="flex items-center gap-1">
        {hasCtrl && (
          <>
            <kbd className="px-2 py-1 rounded text-xs font-mono bg-slate-100 text-slate-700 border border-slate-300 shadow-sm">
              Ctrl
            </kbd>
            <span className="text-slate-400">+</span>
          </>
        )}
        {hasShift && (
          <>
            <kbd className="px-2 py-1 rounded text-xs font-mono bg-slate-100 text-slate-700 border border-slate-300 shadow-sm">
              Shift
            </kbd>
            <span className="text-slate-400">+</span>
          </>
        )}
        {hasAlt && (
          <>
            <kbd className="px-2 py-1 rounded text-xs font-mono bg-slate-100 text-slate-700 border border-slate-300 shadow-sm">
              Alt
            </kbd>
            <span className="text-slate-400">+</span>
          </>
        )}
        <kbd className="px-2 py-1 rounded text-xs font-mono bg-slate-100 text-slate-700 border border-slate-300 shadow-sm">
          {shortcut.label.toUpperCase()}
        </kbd>
      </div>
    </div>
  )
})

KeyboardShortcutsModal.displayName = 'KeyboardShortcutsModal'

export default KeyboardShortcutsModal
