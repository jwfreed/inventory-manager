import { Button } from '@shared/ui'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import OnboardingCard from '../components/OnboardingCard'
import { useOnboarding } from '../hooks'
import { trackOnboardingEvent } from '../analytics'
import { ONBOARDING_FIRST_ACTION_KEY } from '../constants'

export default function WelcomePage() {
  const navigate = useNavigate()
  const { setStep, setExploreMode } = useOnboarding()

  const startFirstActionClock = () => {
    if (typeof window === 'undefined') return
    if (!window.localStorage.getItem(ONBOARDING_FIRST_ACTION_KEY)) {
      window.localStorage.setItem(ONBOARDING_FIRST_ACTION_KEY, String(Date.now()))
    }
  }

  const handleGetStarted = () => {
    trackOnboardingEvent('onboarding_get_started_clicked', {
      step_name: 'welcome',
      step_index: 0,
      timestamp: new Date().toISOString(),
      skipped: false,
    })
    setExploreMode(false)
    setStep('account')
    startFirstActionClock()
    navigate('/onboarding/account')
  }

  const handleExplore = () => {
    trackOnboardingEvent('onboarding_explore_clicked', {
      step_name: 'welcome',
      step_index: 0,
      timestamp: new Date().toISOString(),
      skipped: true,
    })
    setExploreMode(true)
    setStep('context')
    startFirstActionClock()
    navigate('/onboarding/context')
  }

  useEffect(() => {
    trackOnboardingEvent('onboarding_welcome_viewed', {
      step_name: 'welcome',
      step_index: 0,
      timestamp: new Date().toISOString(),
    })
  }, [])

  return (
    <OnboardingCard
      title="Always know what’s in stock."
      description="Avoid stockouts. Save hours per week."
    >
      <div className="flex flex-wrap gap-3">
        <Button onClick={handleGetStarted}>Get started</Button>
        <Button variant="secondary" onClick={handleExplore}>
          I’m just exploring
        </Button>
      </div>
    </OnboardingCard>
  )
}
