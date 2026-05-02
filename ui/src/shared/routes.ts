import type { Params, RouteObject } from 'react-router-dom'
import type { Permission } from '../lib/permissions'

export type NavSection = 
  | 'dashboard'
  | 'inbound'
  | 'inventory'
  | 'production'
  | 'outbound'
  | 'reports'
  | 'master-data'
  | 'profile'
  | 'admin'

export type AppNavItem = {
  label: string
  to: string
  order?: number
  disabled?: boolean
  section?: NavSection
  icon?: string
  description?: string
  permission?: Permission
}

export type AppRouteHandle = {
  breadcrumb?: string | ((params: Params) => string)
  nav?: AppNavItem
  permission?: Permission
}

export type AppRouteObject = Omit<RouteObject, 'children' | 'handle'> & {
  children?: AppRouteObject[]
  handle?: AppRouteHandle
}
