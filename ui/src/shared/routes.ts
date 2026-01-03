import type { Params, RouteObject } from 'react-router-dom'

export type NavSection = 
  | 'dashboard'
  | 'inbound'
  | 'inventory'
  | 'production'
  | 'outbound'
  | 'reports'
  | 'master-data'
  | 'profile'

export type AppNavItem = {
  label: string
  to: string
  order?: number
  disabled?: boolean
  section?: NavSection
  icon?: string
  description?: string
}

export type AppRouteHandle = {
  breadcrumb?: string | ((params: Params) => string)
  nav?: AppNavItem
}

export type AppRouteObject = Omit<RouteObject, 'children' | 'handle'> & {
  children?: AppRouteObject[]
  handle?: AppRouteHandle
}
