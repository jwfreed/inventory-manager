export const ONBOARDING_STORAGE_KEY = 'onboarding_progress_v1'
export const ONBOARDING_FIRST_ACTION_KEY = 'onboarding_first_action_started_at'
export const ONBOARDING_SESSION_TIPS_KEY = 'onboarding_tips_dismissed_v1'

export type OnboardingStepId =
  | 'welcome'
  | 'account'
  | 'context'
  | 'first_win'
  | 'checklist'
  | 'done'

export type OnboardingChecklistId =
  | 'add_item'
  | 'set_location'
  | 'set_low_stock'
  | 'invite_team'

export const ONBOARDING_STEPS: { id: OnboardingStepId; index: number }[] = [
  { id: 'welcome', index: 0 },
  { id: 'account', index: 1 },
  { id: 'context', index: 2 },
  { id: 'first_win', index: 3 },
  { id: 'checklist', index: 4 },
  { id: 'done', index: 5 },
]
