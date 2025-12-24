import type { Params, RouteObject } from 'react-router-dom'

export type AppNavItem = {
  label: string
  to: string
  order?: number
  disabled?: boolean
  group?: string
}

export type AppRouteHandle = {
  breadcrumb?: string | ((params: Params) => string)
  nav?: AppNavItem
}

export type AppRouteObject = Omit<RouteObject, 'children' | 'handle'> & {
  children?: AppRouteObject[]
  handle?: AppRouteHandle
}
