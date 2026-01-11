import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useReceivingContext } from '../context'
import { useResponsive } from '../hooks/useResponsive'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { OfflineIndicator } from './OfflineIndicator'
import { useState } from 'react'

type Step = {
  id: string
  label: string
  path: string
  description: string
}

const steps: Step[] = [
  {
    id: 'receipt',
    label: 'Receipt',
    path: '/receiving/receipt',
    description: 'Capture PO receipt',
  },
  {
    id: 'qc',
    label: 'QC',
    path: '/receiving/qc',
    description: 'Quality classification',
  },
  {
    id: 'putaway',
    label: 'Putaway',
    path: '/receiving/putaway',
    description: 'Plan storage location',
  },
]

type Props = {
  children: React.ReactNode
}

export function ReceivingLayout({ children }: Props) {
  const location = useLocation()
  const navigate = useNavigate()
  const ctx = useReceivingContext()
  const { isMobile } = useResponsive()
  const [showMobileMenu, setShowMobileMenu] = useState(false)

  // Global navigation shortcuts
  useKeyboardShortcuts([
    { key: '1', handler: () => navigate('/receiving/receipt') },
    { key: '2', handler: () => navigate('/receiving/qc') },
    { key: '3', handler: () => navigate('/receiving/putaway') },
  ])

  const currentStepIndex = steps.findIndex((s) => location.pathname === s.path)
  const currentStep = steps[currentStepIndex]

  const getStepStatus = (index: number): 'completed' | 'active' | 'upcoming' => {
    if (index < currentStepIndex) return 'completed'
    if (index === currentStepIndex) return 'active'
    return 'upcoming'
  }

  const canNavigateToStep = (step: Step): boolean => {
    // Can always go to receipt
    if (step.id === 'receipt') return true

    // Can go to QC if there's a receipt loaded
    if (step.id === 'qc') {
      return !!ctx.receiptIdForQc
    }

    // Can go to putaway if there's a putaway ID
    if (step.id === 'putaway') {
      return !!ctx.putawayId
    }

    return false
  }

  return (
    <div className="space-y-6">
      {/* Mobile: Compact Header with Menu Toggle */}
      {isMobile ? (
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
          <div className="px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={`
                    w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold
                    ${getStepStatus(currentStepIndex) === 'active' ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'}
                  `}
                >
                  {currentStepIndex + 1}
                </div>
                <div>
                  <div className="text-sm font-semibold text-slate-900">{currentStep?.label}</div>
                  <div className="text-xs text-slate-500">
                    Step {currentStepIndex + 1} of {steps.length}
                  </div>
                </div>
              </div>
              
              <button
                onClick={() => setShowMobileMenu(!showMobileMenu)}
                className="p-2 rounded-lg hover:bg-slate-100 transition-colors"
                aria-label="Toggle navigation"
              >
                <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {showMobileMenu ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  )}
                </svg>
              </button>
            </div>

            {/* Mobile Menu Dropdown */}
            {showMobileMenu && (
              <div className="mt-3 pt-3 border-t border-slate-200 space-y-2">
                {steps.map((step, index) => {
                  const status = getStepStatus(index)
                  const canNavigate = canNavigateToStep(step)

                  return (
                    <Link
                      key={step.id}
                      to={step.path}
                      className={`
                        flex items-center gap-3 px-3 py-2 rounded-lg transition-colors
                        ${status === 'active' ? 'bg-indigo-50' : ''}
                        ${canNavigate ? 'hover:bg-slate-50' : 'opacity-50 cursor-not-allowed'}
                      `}
                      onClick={(e) => {
                        if (!canNavigate) {
                          e.preventDefault()
                        } else {
                          setShowMobileMenu(false)
                        }
                      }}
                    >
                      <div
                        className={`
                          w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold
                          ${status === 'completed' ? 'bg-green-600 text-white' : ''}
                          ${status === 'active' ? 'bg-indigo-600 text-white' : ''}
                          ${status === 'upcoming' ? 'bg-slate-200 text-slate-400' : ''}
                        `}
                      >
                        {index + 1}
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-slate-900">{step.label}</div>
                        <div className="text-xs text-slate-500">{step.description}</div>
                      </div>
                    </Link>
                  )
                })}
                
                {/* Context Info */}
                <div className="pt-2 border-t border-slate-200 space-y-1 text-xs">
                  {ctx.selectedPoId && ctx.poQuery.data && (
                    <div className="flex items-center gap-2 text-slate-600">
                      <span>PO:</span>
                      <span className="font-mono">{ctx.poQuery.data.poNumber}</span>
                    </div>
                  )}
                  {ctx.receiptIdForQc && ctx.receiptQuery.data && (
                    <div className="flex items-center gap-2 text-slate-600">
                      <span>Receipt:</span>
                      <span className="font-mono">{ctx.receiptQuery.data.id.slice(0, 8)}...</span>
                    </div>
                  )}
                  {ctx.putawayId && ctx.putawayQuery.data && (
                    <div className="flex items-center gap-2 text-slate-600">
                      <span>Putaway:</span>
                      <span className="font-mono">{ctx.putawayQuery.data.id.slice(0, 8)}...</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Desktop: Full Stepper */
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              {steps.map((step, index) => {
                const status = getStepStatus(index)
                const canNavigate = canNavigateToStep(step)
                const isLast = index === steps.length - 1

                return (
                  <div key={step.id} className="flex items-center flex-1">
                    {/* Step */}
                    <Link
                      to={step.path}
                      className={`
                        flex items-center gap-3 px-4 py-2 rounded-lg transition-colors
                        ${status === 'active' ? 'bg-indigo-50' : ''}
                        ${canNavigate ? 'hover:bg-slate-50 cursor-pointer' : 'cursor-not-allowed opacity-50'}
                      `}
                      onClick={(e) => {
                        if (!canNavigate) e.preventDefault()
                      }}
                    >
                      {/* Icon */}
                      <div
                        className={`
                          flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-sm font-semibold
                          ${status === 'completed' ? 'bg-green-600 text-white' : ''}
                          ${status === 'active' ? 'bg-indigo-600 text-white' : ''}
                          ${status === 'upcoming' ? 'bg-slate-200 text-slate-400' : ''}
                        `}
                      >
                        {index + 1}
                      </div>

                      {/* Label & Description */}
                      <div className="flex flex-col min-w-0">
                        <div
                          className={`
                            text-sm font-semibold
                            ${status === 'active' ? 'text-indigo-900' : ''}
                            ${status === 'completed' ? 'text-slate-700' : ''}
                            ${status === 'upcoming' ? 'text-slate-400' : ''}
                          `}
                        >
                          {step.label}
                        </div>
                        <div className="text-xs text-slate-500 truncate">{step.description}</div>
                      </div>
                    </Link>

                    {/* Connector Line */}
                    {!isLast && (
                      <div className="flex-1 h-px bg-slate-200 mx-2" aria-hidden="true" />
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Current Step Context */}
          {currentStep && (
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-200">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-4">
                  {ctx.selectedPoId && ctx.poQuery.data && (
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500">PO:</span>
                      <span className="font-mono text-slate-900">{ctx.poQuery.data.poNumber}</span>
                    </div>
                  )}
                  {ctx.receiptIdForQc && ctx.receiptQuery.data && (
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500">Receipt:</span>
                      <span className="font-mono text-slate-900">{ctx.receiptQuery.data.id}</span>
                    </div>
                  )}
                  {ctx.putawayId && ctx.putawayQuery.data && (
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500">Putaway:</span>
                      <span className="font-mono text-slate-900">{ctx.putawayQuery.data.id}</span>
                    </div>
                  )}
                </div>

                <div className="text-xs text-slate-500">
                  Step {currentStepIndex + 1} of {steps.length}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Page Content */}
      <div>{children}</div>

      {/* Offline Indicator */}
      <OfflineIndicator
        isOnline={ctx.isOnline}
        pendingCount={ctx.pendingCount}
        isSyncing={ctx.isSyncing}
        onSync={() => ctx.syncPendingOperations()}
        onViewQueue={() => {
          // TODO: Show queue viewer modal
          console.log('View queue:', ctx.pendingOperations)
        }}
      />
    </div>
  )
}
