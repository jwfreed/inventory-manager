import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { Modal } from '../../components/Modal'
import { cn } from '../../lib/utils'
import { SeverityPill } from './SeverityPill'
import { severityTokens, type Severity } from './severity'

export type MetricExplanation = {
  formula: string
  sources: string[]
  asOf: string
  queryHint?: string
  scope?: string
}

type Props = {
  title: string
  value: string
  unit?: string
  severity: Severity
  helper: string
  to: string
  ctaLabel?: string
  explanation: MetricExplanation
  className?: string
}

export function MetricCard({
  title,
  value,
  unit,
  severity,
  helper,
  to,
  ctaLabel = 'View',
  explanation,
  className,
}: Props) {
  const [explainOpen, setExplainOpen] = useState(false)
  const severityToken = severityTokens[severity]
  const modalTitle = useMemo(() => `Explain: ${title}`, [title])

  return (
    <>
      <Card
        className={cn(
          'h-full transition-colors',
          severityToken.borderClassName,
          severity === 'critical' || severity === 'action' ? severityToken.tintClassName : 'bg-white',
          className,
        )}
      >
        <div className="flex h-full flex-col justify-between gap-3">
          <div>
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
              <SeverityPill severity={severity} />
            </div>
            <div className="mt-2">
              <Link
                to={to}
                className="inline-flex items-baseline gap-1 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                aria-label={`View drilldown for ${title}`}
              >
                <span className="text-3xl font-semibold tracking-tight text-slate-900">{value}</span>
                {unit ? <span className="text-sm text-slate-500">{unit}</span> : null}
              </Link>
            </div>
            <p className="mt-1 text-xs text-slate-500">{helper}</p>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Link to={to}>
              <Button size="sm" variant="secondary" aria-label={`${ctaLabel} ${title}`}>
                {ctaLabel}
              </Button>
            </Link>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setExplainOpen(true)}
              aria-label={`Explain ${title}`}
            >
              Explain
            </Button>
          </div>
        </div>
      </Card>
      <Modal
        isOpen={explainOpen}
        onClose={() => setExplainOpen(false)}
        title={modalTitle}
      >
        <div className="space-y-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Formula</p>
            <p className="mt-1 text-sm text-slate-800">{explanation.formula}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Source query</p>
            <p className="mt-1 text-sm text-slate-800">{explanation.queryHint ?? 'See listed sources.'}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
              {explanation.sources.map((source) => (
                <li key={source}>{source}</li>
              ))}
            </ul>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">As of</p>
              <p className="mt-1 text-sm text-slate-800">{explanation.asOf}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Warehouse scope</p>
              <p className="mt-1 text-sm text-slate-800">{explanation.scope ?? 'Default warehouse'}</p>
            </div>
          </div>
        </div>
      </Modal>
    </>
  )
}
