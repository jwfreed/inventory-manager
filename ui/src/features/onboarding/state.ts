import { ONBOARDING_STORAGE_KEY, ONBOARDING_SESSION_TIPS_KEY, type OnboardingChecklistId, type OnboardingStepId } from './constants'

export type OnboardingStatus = 'not_started' | 'in_progress' | 'partial' | 'completed'

export type OnboardingProgress = {
  status: OnboardingStatus
  step: OnboardingStepId
  exploreMode: boolean
  businessType?: string | null
  userRole?: string | null
  pathChosen?: string | null
  checklist: Record<OnboardingChecklistId, boolean>
  itemsCreated: number
  tipsShown: Record<string, boolean>
  updatedAt: string
}

const defaultChecklist: Record<OnboardingChecklistId, boolean> = {
  add_item: false,
  set_location: false,
  set_low_stock: false,
  invite_team: false,
}

const defaultProgress: OnboardingProgress = {
  status: 'not_started',
  step: 'welcome',
  exploreMode: false,
  businessType: null,
  userRole: null,
  pathChosen: null,
  checklist: { ...defaultChecklist },
  itemsCreated: 0,
  tipsShown: {},
  updatedAt: new Date().toISOString(),
}

export function loadOnboardingProgress(): OnboardingProgress {
  if (typeof window === 'undefined') return { ...defaultProgress }
  const stored = window.localStorage.getItem(ONBOARDING_STORAGE_KEY)
  if (!stored) return { ...defaultProgress }
  try {
    const parsed = JSON.parse(stored)
    return {
      ...defaultProgress,
      ...parsed,
      checklist: { ...defaultChecklist, ...(parsed.checklist ?? {}) },
      tipsShown: { ...(parsed.tipsShown ?? {}) },
    }
  } catch {
    return { ...defaultProgress }
  }
}

export function saveOnboardingProgress(progress: OnboardingProgress) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(progress))
}

export function updateOnboardingProgress(
  updater: (current: OnboardingProgress) => OnboardingProgress,
): OnboardingProgress {
  const current = loadOnboardingProgress()
  const next = updater(current)
  saveOnboardingProgress(next)
  return next
}

export function markTipDismissed(tipId: string) {
  if (typeof window === 'undefined') return
  const stored = window.sessionStorage.getItem(ONBOARDING_SESSION_TIPS_KEY)
  const dismissed = stored ? new Set<string>(JSON.parse(stored)) : new Set<string>()
  dismissed.add(tipId)
  window.sessionStorage.setItem(ONBOARDING_SESSION_TIPS_KEY, JSON.stringify(Array.from(dismissed)))
}

export function isTipDismissed(tipId: string) {
  if (typeof window === 'undefined') return false
  const stored = window.sessionStorage.getItem(ONBOARDING_SESSION_TIPS_KEY)
  if (!stored) return false
  try {
    const parsed = JSON.parse(stored)
    return Array.isArray(parsed) && parsed.includes(tipId)
  } catch {
    return false
  }
}
