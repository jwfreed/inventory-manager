import { describe, expect, it } from 'vitest'
import type { UIMatch } from 'react-router-dom'
import type { AppRouteHandle } from '@shared/routes'
import { getPageChromeState } from './usePageChrome'

const makeMatch = (handle?: AppRouteHandle, pathname = '/'): UIMatch => {
  return {
    id: pathname,
    pathname,
    params: {},
    data: null,
    handle,
  } as unknown as UIMatch
}

describe('getPageChromeState', () => {
  it('hides title when sidebar is visible and route is shallow', () => {
    const matches = [
      makeMatch({
        breadcrumb: 'Home',
        nav: { label: 'Home', to: '/home', section: 'dashboard' },
      }),
    ]
    const state = getPageChromeState(matches, true)
    expect(state.hideTitle).toBe(true)
    expect(state.showBreadcrumbs).toBe(false)
  })

  it('allows title when sidebar is not visible', () => {
    const matches = [
      makeMatch({
        breadcrumb: 'Home',
        nav: { label: 'Home', to: '/home', section: 'dashboard' },
      }),
    ]
    const state = getPageChromeState(matches, false)
    expect(state.hideTitle).toBe(false)
    expect(state.showBreadcrumbs).toBe(true)
  })
})
