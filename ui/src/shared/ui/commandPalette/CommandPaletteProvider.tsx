import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { CommandPaletteModal } from './CommandPaletteModal'
import { useCommandRegistry, type CommandAction } from './useCommandRegistry'
import { CommandPaletteContext } from './CommandPaletteContext'

type Props = {
  children: ReactNode
}

export function CommandPaletteProvider({ children }: Props) {
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { commands, isLoading } = useCommandRegistry({ query, navigate })

  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => {
    setIsOpen(false)
    setQuery('')
  }, [])
  const toggle = useCallback(() => {
    setIsOpen((current) => {
      const next = !current
      if (!next) setQuery('')
      return next
    })
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        toggle()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggle])

  const runCommand = useCallback(
    (command: CommandAction) => {
      command.run()
      close()
    },
    [close],
  )

  const value = useMemo(
    () => ({
      open,
      close,
      toggle,
    }),
    [close, open, toggle],
  )

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPaletteModal
        isOpen={isOpen}
        onClose={close}
        commands={commands}
        isLoading={isLoading}
        query={query}
        onQueryChange={setQuery}
        onRun={runCommand}
      />
    </CommandPaletteContext.Provider>
  )
}
