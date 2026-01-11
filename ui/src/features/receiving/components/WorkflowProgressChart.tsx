import { Card } from '@shared/ui'
import { formatNumber } from '@shared/formatters'

type WorkflowStage = {
  id: string
  label: string
  complete: boolean
  stats?: {
    label: string
    value: number | string
  }[]
}

type Props = {
  stages: WorkflowStage[]
  currentStageId: string
  className?: string
}

export function WorkflowProgressChart({ stages, currentStageId, className }: Props) {
  const completedCount = stages.filter((s) => s.complete).length
  const progress = (completedCount / stages.length) * 100

  return (
    <Card className={className}>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">
            Workflow Progress
          </h3>
          <div className="text-right">
            <div className="text-2xl font-bold text-slate-900">{Math.round(progress)}%</div>
            <div className="text-xs text-slate-500">
              {completedCount} of {stages.length}
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="relative">
          <div className="h-2 w-full bg-slate-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-600 transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Stage List */}
        <div className="space-y-2">
          {stages.map((stage) => {
            const isComplete = stage.complete
            const isCurrent = stage.id === currentStageId

            return (
              <div
                key={stage.id}
                className={`
                  rounded-lg p-3 transition-all
                  ${isCurrent ? 'bg-indigo-50 border-2 border-indigo-300' : 'bg-slate-50 border border-slate-200'}
                `}
              >
                <div className="flex items-start gap-3">
                  {/* Status Icon */}
                  <div className="flex-shrink-0 mt-0.5">
                    {isComplete ? (
                      <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center">
                        <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    ) : isCurrent ? (
                      <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center">
                        <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                      </div>
                    ) : (
                      <div className="w-6 h-6 rounded-full border-2 border-slate-300 bg-white" />
                    )}
                  </div>

                  {/* Stage Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <h4
                        className={`text-sm font-semibold ${
                          isCurrent
                            ? 'text-indigo-900'
                            : isComplete
                              ? 'text-slate-700'
                              : 'text-slate-500'
                        }`}
                      >
                        {stage.label}
                      </h4>
                      {isCurrent && (
                        <span className="text-xs font-medium text-indigo-600 uppercase">
                          Active
                        </span>
                      )}
                      {isComplete && !isCurrent && (
                        <span className="text-xs font-medium text-green-600 uppercase">
                          Complete
                        </span>
                      )}
                    </div>

                    {/* Stage Stats */}
                    {stage.stats && stage.stats.length > 0 && (
                      <div className="flex items-center gap-4 text-xs">
                        {stage.stats.map((stat, statIdx) => (
                          <div key={statIdx} className="flex items-center gap-1">
                            <span className="text-slate-500">{stat.label}:</span>
                            <span className="font-semibold text-slate-900">
                              {typeof stat.value === 'number'
                                ? formatNumber(stat.value)
                                : stat.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Card>
  )
}
