import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { cn } from '../lib/utils'
import { Button } from './Button'

type Props = {
  isOpen: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  footer?: ReactNode
  className?: string
}

export function Modal({ isOpen, onClose, title, children, footer, className }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const hasCustomMaxWidth = typeof className === 'string' && className.includes('max-w-')
  const maxWidthClass = hasCustomMaxWidth ? '' : 'max-w-lg'

  useEffect(() => {
    if (!isOpen) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ')

    const setModalOpenState = (delta: number) => {
      const currentCount = Number(document.body.dataset.modalOpenCount ?? '0')
      const nextCount = Math.max(0, currentCount + delta)
      if (nextCount === 0) {
        delete document.body.dataset.modalOpenCount
      } else {
        document.body.dataset.modalOpenCount = String(nextCount)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return

      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => !element.hasAttribute('disabled'),
      )
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement

      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    setModalOpenState(1)
    document.addEventListener('keydown', handleKeyDown)
    const focusTarget =
      dialogRef.current?.querySelector<HTMLElement>('[autofocus], input, button, textarea, select') ??
      dialogRef.current
    focusTarget?.focus()

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      setModalOpenState(-1)
      const previousFocus = previousFocusRef.current
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus()
      }
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4"
      aria-modal="true"
      role="dialog"
      aria-labelledby={title ? titleId : undefined}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={cn(
          'flex max-h-[85vh] w-full flex-col rounded-xl bg-white shadow-card outline-none',
          maxWidthClass,
          className,
        )}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div id={titleId} className="text-base font-semibold text-slate-900">
            {title}
          </div>
          <Button variant="secondary" size="sm" onClick={onClose} aria-label="Close modal">
            Close
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm text-slate-800">{children}</div>
        {footer && <div className="border-t border-slate-200 px-5 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
