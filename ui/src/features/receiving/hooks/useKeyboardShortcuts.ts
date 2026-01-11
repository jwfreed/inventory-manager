import { useEffect, useRef } from 'react'

export type KeyboardShortcut = {
  key: string
  label: string
  description: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  preventDefault?: boolean
}

type ShortcutHandler = {
  key: string
  handler: () => void
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  preventDefault?: boolean
}

/**
 * Hook for managing keyboard shortcuts with conflict prevention
 */
export function useKeyboardShortcuts(
  shortcuts: ShortcutHandler[],
  options: { enabled?: boolean; excludeInputs?: boolean } = {}
) {
  const { enabled = true, excludeInputs = true } = options
  const shortcutsRef = useRef(shortcuts)

  // Keep shortcuts up to date without recreating effect
  useEffect(() => {
    shortcutsRef.current = shortcuts
  }, [shortcuts])

  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (event: KeyboardEvent) => {
      // Skip if typing in input/textarea/contenteditable
      if (excludeInputs) {
        const target = event.target as HTMLElement
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable
        ) {
          return
        }
      }

      const key = event.key.toLowerCase()
      const ctrl = event.ctrlKey || event.metaKey
      const alt = event.altKey
      const shift = event.shiftKey

      for (const shortcut of shortcutsRef.current) {
        const keyMatches = shortcut.key.toLowerCase() === key
        const ctrlMatches = !!shortcut.ctrl === ctrl
        const altMatches = !!shortcut.alt === alt
        const shiftMatches = !!shortcut.shift === shift

        if (keyMatches && ctrlMatches && altMatches && shiftMatches) {
          if (shortcut.preventDefault) {
            event.preventDefault()
          }
          shortcut.handler()
          break // Only trigger first matching shortcut
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, excludeInputs])
}

/**
 * Hook for focus management (e.g., focus search on '/')
 */
export function useFocusShortcut(
  key: string,
  elementRef: React.RefObject<HTMLElement | null>,
  options: { preventDefault?: boolean } = {}
) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Skip if already in an input
      const target = event.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }

      if (event.key === key) {
        if (options.preventDefault) {
          event.preventDefault()
        }
        elementRef.current?.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [key, elementRef, options.preventDefault])
}

/**
 * Hook for Escape key handling
 */
export function useEscapeKey(handler: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handler()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handler, enabled])
}

/**
 * Predefined shortcut definitions for consistency
 */
export const SHORTCUTS = {
  // Navigation
  RECEIPT_PAGE: { key: '1', label: '1', description: 'Go to Receipt Capture' },
  QC_PAGE: { key: '2', label: '2', description: 'Go to QC Classification' },
  PUTAWAY_PAGE: { key: '3', label: '3', description: 'Go to Putaway Planning' },

  // Actions
  ACCEPT: { key: 'a', label: 'A', description: 'Accept QC line' },
  HOLD: { key: 'h', label: 'H', description: 'Hold QC line' },
  REJECT: { key: 'r', label: 'R', description: 'Reject QC line' },
  SAVE: { key: 's', label: 'S', description: 'Save/Submit form', ctrl: true, preventDefault: true },
  POST: { key: 'p', label: 'P', description: 'Post/Complete', ctrl: true, preventDefault: true },

  // Navigation within lists
  NEXT: { key: 'n', label: 'N', description: 'Next item in queue' },
  PREVIOUS: { key: 'p', label: 'P', description: 'Previous item in queue' },

  // Search & Filters
  FOCUS_SEARCH: { key: '/', label: '/', description: 'Focus search input', preventDefault: true },
  CLEAR: { key: 'Escape', label: 'Esc', description: 'Clear/Close' },

  // Help
  HELP: { key: '?', label: '?', description: 'Show keyboard shortcuts', shift: true },
} as const
