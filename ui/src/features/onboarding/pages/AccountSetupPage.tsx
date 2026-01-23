import { Button, Input } from '@shared/ui'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import OnboardingCard from '../components/OnboardingCard'
import { useOnboarding } from '../hooks'
import { useAuth } from '@shared/auth'
import { trackOnboardingEvent } from '../analytics'

export default function AccountSetupPage() {
  const navigate = useNavigate()
  const { progress, setStep } = useOnboarding()
  const { user } = useAuth()

  useEffect(() => {
    if (progress.exploreMode) {
      trackOnboardingEvent('onboarding_account_skipped_explore', {
        step_name: 'account',
        step_index: 1,
        timestamp: new Date().toISOString(),
        skipped: true,
        user_role: progress.userRole ?? null,
        business_type: progress.businessType ?? null,
        path_chosen: progress.pathChosen ?? null,
      })
      setStep('context')
      navigate('/onboarding/context')
      return
    }

    trackOnboardingEvent('onboarding_account_viewed', {
      step_name: 'account',
      step_index: 1,
      timestamp: new Date().toISOString(),
    })
  }, [
    progress.exploreMode,
    progress.userRole,
    progress.businessType,
    progress.pathChosen,
    setStep,
    navigate,
  ])

  const handleContinue = () => {
    trackOnboardingEvent('onboarding_account_created', {
      step_name: 'account',
      step_index: 1,
      timestamp: new Date().toISOString(),
      skipped: false,
      user_role: progress.userRole ?? null,
      business_type: progress.businessType ?? null,
      path_chosen: progress.pathChosen ?? null,
      event: 'email',
    })
    setStep('context')
    navigate('/onboarding/context')
  }

  return (
    <OnboardingCard
      title="Set up your account"
      description="Confirm the basics and continue. You can edit this later in Profile."
    >
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Email</span>
          <Input value={user?.email ?? ''} readOnly />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Password</span>
          <Input type="password" value="********" readOnly />
          <div className="text-xs text-slate-500">Managed in your account settings.</div>
        </label>
      </div>
      <div className="flex justify-end">
        <Button onClick={handleContinue}>Continue</Button>
      </div>
    </OnboardingCard>
  )
}
