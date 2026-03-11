import { createContext } from 'react'

export type CommandPaletteContextValue = {
  open: () => void
  close: () => void
  toggle: () => void
}

export const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null)
