import { useContext } from 'react'
import { CommandPaletteContext } from './CommandPaletteContext'

export function useCommandPalette() {
  const value = useContext(CommandPaletteContext)
  if (!value) {
    throw new Error('useCommandPalette must be used within CommandPaletteProvider')
  }
  return value
}
