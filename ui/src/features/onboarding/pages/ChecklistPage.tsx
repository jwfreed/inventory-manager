import { Button } from '@shared/ui'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import OnboardingCard from '../components/OnboardingCard'
import { useOnboarding } from '../hooks'
import { trackOnboardingEvent } from '../analytics'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'

const checklistItems = [
  { id: 'add_item', label: 'Add item', optional: false },
  { id: 'set_location', label: 'Set a location', optional: true, to: '/locations' },
  { id: 'invite_team', label: 'Invite team', optional: true, to: '/profile' },
] as const

export default function ChecklistPage() {
  const navigate = useNavigate()
  const { progress, markChecklist, markPartial, markCompleted, setStep } = useOnboarding()
  const itemsQuery = useItemsList({ limit: 1 }, { staleTime: 30_000 })
  const locationsQuery = useLocationsList({ active: true, limit: 1 }, { staleTime: 30_000 })

  useEffect(() => {
    trackOnboardingEvent('onboarding_checklist_viewed', {
      step_name: 'checklist',
      step_index: 4,
      timestamp: new Date().toISOString(),
      user_role: progress.userRole ?? null,
      business_type: progress.businessType ?? null,
      path_chosen: progress.pathChosen ?? null,
    })
  }, [progress.userRole, progress.businessType, progress.pathChosen])

  useEffect(() => {
    const hasItems = (itemsQuery.data?.data?.length ?? 0) > 0
    const hasLocations = (locationsQuery.data?.data?.length ?? 0) > 0
    if (hasItems && !progress.checklist.add_item) {
      markChecklist('add_item', true)
    }
    if (hasLocations && !progress.checklist.set_location) {
      markChecklist('set_location', true)
    }
  }, [
    itemsQuery.data,
    locationsQuery.data,
    progress.checklist.add_item,
    progress.checklist.set_location,
    markChecklist,
  ])

  const handleFinishLater = () => {
    markPartial()
    trackOnboardingEvent('onboarding_finish_later_clicked', {
      step_name: 'checklist',
      step_index: 4,
      timestamp: new Date().toISOString(),
      skipped: true,
      user_role: progress.userRole ?? null,
      business_type: progress.businessType ?? null,
      path_chosen: progress.pathChosen ?? null,
    })
    navigate('/home')
  }

  const handleComplete = () => {
    markCompleted()
    setStep('done')
    trackOnboardingEvent('onboarding_completed', {
      step_name: 'done',
      step_index: 5,
      timestamp: new Date().toISOString(),
      user_role: progress.userRole ?? null,
      business_type: progress.businessType ?? null,
      path_chosen: progress.pathChosen ?? null,
    })
    navigate('/onboarding/done')
  }

  return (
    <OnboardingCard
      title="Setup progress"
      description="A few small steps to get the most out of inventory."
    >
      <div className="space-y-3">
        {checklistItems.map((item) => (
          <div key={item.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
            <div className="text-sm text-slate-700">
              <span className="font-semibold">{item.label}</span>
              {item.optional && <span className="ml-2 text-xs text-slate-500">Optional</span>}
            </div>
            {progress.checklist[item.id] ? (
              <span className="text-xs font-semibold text-green-700">Done</span>
            ) : (
              item.to && (
                <Button size="sm" variant="secondary" onClick={() => navigate(item.to)}>
                  Go
                </Button>
              )
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={handleComplete}>Finish setup</Button>
        <Button variant="secondary" onClick={handleFinishLater}>
          Finish setup later
        </Button>
      </div>
    </OnboardingCard>
  )
}
