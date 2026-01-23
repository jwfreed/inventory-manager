import { useCallback, useMemo, useState } from 'react'
import { loadOnboardingProgress, saveOnboardingProgress, updateOnboardingProgress } from './state'
import type { OnboardingChecklistId, OnboardingStepId } from './constants'

export function useOnboarding() {
  const [progress, setProgress] = useState(loadOnboardingProgress)

  const update = useCallback((updater: (current: typeof progress) => typeof progress) => {
    const next = updateOnboardingProgress(updater)
    setProgress(next)
    return next
  }, [])

  const setStep = useCallback((step: OnboardingStepId) => {
    update((current) => ({
      ...current,
      step,
      status: current.status === 'completed' ? 'completed' : 'in_progress',
      updatedAt: new Date().toISOString(),
    }))
  }, [update])

  const setExploreMode = useCallback((exploreMode: boolean) => {
    update((current) => ({
      ...current,
      exploreMode,
      status: current.status === 'completed' ? 'completed' : 'in_progress',
      updatedAt: new Date().toISOString(),
    }))
  }, [update])

  const setContext = useCallback((businessType: string, userRole: string) => {
    update((current) => ({
      ...current,
      businessType,
      userRole,
      updatedAt: new Date().toISOString(),
    }))
  }, [update])

  const setPathChosen = useCallback((pathChosen: string) => {
    update((current) => ({
      ...current,
      pathChosen,
      updatedAt: new Date().toISOString(),
    }))
  }, [update])

  const markChecklist = useCallback((id: OnboardingChecklistId, value = true) => {
    update((current) => ({
      ...current,
      checklist: { ...current.checklist, [id]: value },
      updatedAt: new Date().toISOString(),
    }))
  }, [update])

  const markItemCreated = useCallback(() => {
    update((current) => ({
      ...current,
      itemsCreated: (current.itemsCreated ?? 0) + 1,
      checklist: { ...current.checklist, add_item: true },
      updatedAt: new Date().toISOString(),
    }))
  }, [update])

  const markTipShown = useCallback((tipId: string) => {
    update((current) => ({
      ...current,
      tipsShown: { ...current.tipsShown, [tipId]: true },
      updatedAt: new Date().toISOString(),
    }))
  }, [update])

  const markCompleted = useCallback(() => {
    update((current) => ({
      ...current,
      status: 'completed',
      step: 'done',
      updatedAt: new Date().toISOString(),
    }))
  }, [update])

  const markPartial = useCallback(() => {
    update((current) => ({
      ...current,
      status: 'partial',
      updatedAt: new Date().toISOString(),
    }))
  }, [update])

  const reset = useCallback(() => {
    const fresh = loadOnboardingProgress()
    saveOnboardingProgress(fresh)
    setProgress(fresh)
  }, [])

  const isIncomplete = useMemo(() => progress.status !== 'completed', [progress.status])

  return {
    progress,
    isIncomplete,
    update,
    setStep,
    setExploreMode,
    setContext,
    setPathChosen,
    markChecklist,
    markItemCreated,
    markTipShown,
    markCompleted,
    markPartial,
    reset,
  }
}
