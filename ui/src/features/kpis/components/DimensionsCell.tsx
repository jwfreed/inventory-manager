import { useMemo, useState } from 'react'
import { Button } from '../../../components/Button'

type Props = {
  dimensions?: Record<string, unknown> | null
}

function isPrimitive(value: unknown) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

export function DimensionsCell({ dimensions }: Props) {
  const entries = useMemo(() => {
    if (!dimensions || typeof dimensions !== 'object') return []
    return Object.entries(dimensions).filter(([, value]) => value !== undefined)
  }, [dimensions])

  const [expanded, setExpanded] = useState(false)
  const compact =
    entries.length > 0 &&
    entries.length <= 4 &&
    entries.every(([, value]) => isPrimitive(value)) &&
    entries.every(([, value]) => String(value ?? '').length < 40)

  if (!entries.length) {
    return <span className="text-sm text-slate-500">—</span>
  }

  if (compact) {
    return (
      <div className="flex flex-wrap gap-2">
        {entries.map(([key, value]) => (
          <span
            key={key}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700"
          >
            <span className="font-semibold">{key}:</span>
            <span>{String(value)}</span>
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <Button variant="secondary" size="sm" onClick={() => setExpanded((prev) => !prev)}>
        {expanded ? 'Hide dimensions' : 'View dimensions'}
      </Button>
      {expanded && (
        <pre className="max-h-48 overflow-auto rounded-lg bg-slate-900 px-3 py-2 text-xs text-slate-100">
          {JSON.stringify(dimensions, null, 2)}
        </pre>
      )}
    </div>
  )
}
