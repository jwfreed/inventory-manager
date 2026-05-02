import type { AppRouteObject } from '../../shared/routes'
import DashboardPage from './pages/DashboardPage'
import ResolutionQueuePage from './pages/ResolutionQueuePage'

export const kpiRoutes: AppRouteObject[] = [
  {
    path: 'dashboard',
    element: <DashboardPage />,
    handle: {
      breadcrumb: 'Dashboard',
      permission: 'reports:read',
      nav: {
        label: 'Dashboard',
        to: '/dashboard',
        section: 'dashboard',
        order: 11,
        description: 'Key performance indicators and metrics',
      },
    },
  },
  {
    path: 'dashboard/resolution-queue',
    element: <ResolutionQueuePage />,
    handle: {
      breadcrumb: 'Resolution Queue',
      permission: 'reports:read',
    },
  },
]
