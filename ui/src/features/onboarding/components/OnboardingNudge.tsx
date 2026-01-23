import { Button, Alert } from '@shared/ui'
import { useNavigate } from 'react-router-dom'
import { useOnboarding } from '../hooks'

export default function OnboardingNudge() {
  const navigate = useNavigate()
  const { progress, markPartial } = useOnboarding()
  if (progress.status === 'completed' || progress.status === 'partial') return null

  return (
    <Alert
      variant="info"
      title="Finish setup when you're ready"
      message="Complete onboarding to set defaults and learn key workflows."
      action={
        <div className="flex gap-2">
          <Button size="sm" onClick={() => navigate('/onboarding/checklist')}>
            Continue
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => markPartial()}
          >
            Dismiss
          </Button>
        </div>
      }
    />
  )
}
