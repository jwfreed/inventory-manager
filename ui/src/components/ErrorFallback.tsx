import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'

type ErrorFallbackProps = {
  errorId: string
  error?: unknown
  componentStack?: string
  onGoHome?: () => void
}

export default function ErrorFallback({
  errorId,
  error,
  componentStack,
  onGoHome,
}: ErrorFallbackProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const handleReload = () => window.location.reload()
  const handleGoHome = () => {
    if (onGoHome) onGoHome()
    else window.location.assign('/')
  }
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(errorId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  const message = error instanceof Error ? error.message : undefined
  const stack = error instanceof Error ? error.stack : undefined
  const isProd = import.meta.env.PROD

  return (
    <div className="min-h-screen bg-slate-50 px-6 py-16 text-slate-900">
      <div className="mx-auto w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div role="alert" aria-live="assertive" className="sr-only">
          An unexpected error occurred.
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none"
        >
          Something went wrong
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          We ran into an unexpected issue. You can try reloading, or go back to Home.
        </p>
        <div className="mt-2 text-sm text-slate-500">
          <div>If this keeps happening, share this Error ID with support:</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-slate-700">
              {errorId}
            </code>
            <button
              type="button"
              className="text-xs font-medium text-brand-700 underline"
              onClick={handleCopy}
              aria-live="polite"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={handleReload}>Reload</Button>
          <Button variant="secondary" onClick={handleGoHome}>
            Go Home
          </Button>
          {!isProd && (
            <button
              type="button"
              className="text-sm font-medium text-brand-700 underline"
              onClick={() => setShowDetails((prev) => !prev)}
              aria-expanded={showDetails}
            >
              {showDetails ? 'Hide details' : 'Show details'}
            </button>
          )}
        </div>
        {!isProd && showDetails && (
          <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
            <div className="mb-2 font-semibold">Error details</div>
            {message && <div className="mb-2">Message: {message}</div>}
            {stack && (
              <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed">{stack}</pre>
            )}
            {componentStack && (
              <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                {componentStack}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
