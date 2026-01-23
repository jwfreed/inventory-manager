import { Button } from '@shared/ui'
import { useNavigate } from 'react-router-dom'
import OnboardingCard from '../components/OnboardingCard'
import { trackOnboardingEvent } from '../analytics'
import { useOnboarding } from '../hooks'

export default function DonePage() {
  const navigate = useNavigate()
  const { progress } = useOnboarding()

  const handleGoHome = () => {
    trackOnboardingEvent('onboarding_go_to_dashboard_clicked', {
      step_name: 'done',
      step_index: 5,
      timestamp: new Date().toISOString(),
      user_role: progress.userRole ?? null,
      business_type: progress.businessType ?? null,
      path_chosen: progress.pathChosen ?? null,
    })
    navigate('/home')
  }

  return (
    <OnboardingCard title="You’re all set." description="You can keep working or invite someone else to join.">
      <div className="flex flex-wrap gap-2">
        <Button onClick={handleGoHome}>Go to dashboard</Button>
        <Button variant="secondary" onClick={() => navigate('/profile')}>
          Invite team
        </Button>
      </div>
    </OnboardingCard>
  )
}
