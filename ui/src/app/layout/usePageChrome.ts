import { useMatches } from 'react-router-dom'
import type { UIMatch } from 'react-router-dom'
import type { AppRouteHandle } from '@shared/routes'
import { useSidebarVisibility } from './useSidebarVisibility'

type PageChromeState = {
  hideTitle: boolean
  showBreadcrumbs: boolean
  isShallow: boolean
  sidebarVisible: boolean
}

function getBreadcrumbCount(matches: UIMatch[]) {
  return matches.filter((match) => {
    const handle = match.handle as AppRouteHandle | undefined
    return Boolean(handle?.breadcrumb)
  }).length
}

function hasNavMatch(matches: UIMatch[]) {
  return matches.some((match) => {
    const handle = match.handle as AppRouteHandle | undefined
    return Boolean(handle?.nav)
  })
}

export function getPageChromeState(matches: UIMatch[], sidebarVisible: boolean): PageChromeState {
  const breadcrumbCount = getBreadcrumbCount(matches)
  const isShallow = breadcrumbCount <= 1 && hasNavMatch(matches)
  const hideTitle = sidebarVisible && isShallow
  const showBreadcrumbs = !hideTitle || breadcrumbCount > 1

  return { hideTitle, showBreadcrumbs, isShallow, sidebarVisible }
}

export function usePageChrome(): PageChromeState {
  const matches = useMatches()
  const sidebarVisible = useSidebarVisibility()
  return getPageChromeState(matches, sidebarVisible)
}
