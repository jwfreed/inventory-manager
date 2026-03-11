import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../../../components/Modal'
import { cn } from '../../../lib/utils'
import type { CommandAction } from './useCommandRegistry'

type Props = {
  isOpen: boolean
  onClose: () => void
  commands: CommandAction[]
  isLoading?: boolean
  query: string
  onQueryChange: (value: string) => void
  onRun: (command: CommandAction) => void
}

export function CommandPaletteModal({
  isOpen,
  onClose,
  commands,
  isLoading = false,
  query,
  onQueryChange,
  onRun,
}: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const boundedSelectedIndex =
    commands.length === 0 ? -1 : Math.max(0, Math.min(selectedIndex, commands.length - 1))

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedIndex((current) => Math.min(commands.length - 1, current + 1))
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex((current) => Math.max(0, current - 1))
      }
      if (event.key === 'Enter' && commands[boundedSelectedIndex]) {
        event.preventDefault()
        onRun(commands[boundedSelectedIndex])
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [boundedSelectedIndex, commands, isOpen, onRun])

  const groupedCommands = useMemo(() => {
    return commands.reduce<Record<string, CommandAction[]>>((acc, command) => {
      acc[command.group] = [...(acc[command.group] ?? []), command]
      return acc
    }, {})
  }, [commands])

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Command palette"
      className="max-w-2xl"
    >
      <div className="space-y-4">
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search items, work orders, locations, and actions"
          className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
        />
        <div className="max-h-[55vh] space-y-4 overflow-y-auto">
          {Object.entries(groupedCommands).map(([group, entries]) => (
            <div key={group} className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {group}
              </div>
              <div className="space-y-1">
                {entries.map((command) => {
                  const index = commands.findIndex((entry) => entry.id === command.id)
                  return (
                    <button
                      key={command.id}
                      type="button"
                      onClick={() => onRun(command)}
                      className={cn(
                        'flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition',
                        index === boundedSelectedIndex
                          ? 'bg-brand-50 text-brand-900'
                          : 'text-slate-700 hover:bg-slate-50',
                      )}
                    >
                      <span className="font-medium">{command.label}</span>
                      {command.meta ? (
                        <span className="truncate pl-4 text-xs text-slate-500">{command.meta}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          {!isLoading && commands.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
              No commands found for this search.
            </div>
          ) : null}
          {isLoading ? (
            <div className="text-sm text-slate-500">Loading commands…</div>
          ) : null}
        </div>
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Arrow keys move. Enter opens.</span>
          <span>Cmd/Ctrl + K opens this palette.</span>
        </div>
      </div>
    </Modal>
  )
}
