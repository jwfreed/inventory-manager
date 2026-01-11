/**
 * Component for displaying keyboard shortcut badge
 */
export function KeyboardHint({ shortcut }: { shortcut: string }) {
  return (
    <kbd className="hidden lg:inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono bg-slate-100 text-slate-600 border border-slate-300 shadow-sm">
      {shortcut}
    </kbd>
  )
}
