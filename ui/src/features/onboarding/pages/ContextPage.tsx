import { useEffect, useState } from 'react'
import { Button } from '@shared/ui'
import { useNavigate } from 'react-router-dom'
import OnboardingCard from '../components/OnboardingCard'
import { useOnboarding } from '../hooks'
import { trackOnboardingEvent } from '../analytics'

const businessOptions = ['Retail', 'Warehouse', 'E-commerce', 'Manufacturing']
const roleOptions = ['Owner', 'Operations', 'Inventory clerk']

export default function ContextPage() {
  const navigate = useNavigate()
  const { progress, setContext, setStep } = useOnboarding()
  const [businessType, setBusinessType] = useState(progress.businessType ?? businessOptions[0])
  const [userRole, setUserRole] = useState(progress.userRole ?? roleOptions[0])

  useEffect(() => {
    trackOnboardingEvent('onboarding_context_viewed', {
      step_name: 'context',
      step_index: 2,
      timestamp: new Date().toISOString(),
      user_role: progress.userRole ?? null,
      business_type: progress.businessType ?? null,
      path_chosen: progress.pathChosen ?? null,
    })
  }, [progress.userRole, progress.businessType, progress.pathChosen])

  const handleSubmit = () => {
    setContext(businessType, userRole)
    trackOnboardingEvent('onboarding_context_submitted', {
      step_name: 'context',
      step_index: 2,
      timestamp: new Date().toISOString(),
      business_type: businessType,
      user_role: userRole,
      path_chosen: progress.pathChosen ?? null,
    })
    setStep('first_win')
    navigate('/onboarding/first-win')
  }

  return (
    <OnboardingCard
      title="Tell us about your work"
      description="We’ll use this to tailor defaults and guidance."
    >
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">I manage inventory for</span>
          <select
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={businessType}
            onChange={(e) => setBusinessType(e.target.value)}
          >
            {businessOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">My role</span>
          <select
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={userRole}
            onChange={(e) => setUserRole(e.target.value)}
          >
            {roleOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex justify-end">
        <Button onClick={handleSubmit}>Continue</Button>
      </div>
    </OnboardingCard>
  )
}
