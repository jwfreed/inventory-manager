import type { AppRouteObject } from '../../shared/routes'
import DashboardPage from './pages/DashboardPage'

export const kpiRoutes: AppRouteObject[] = [
  {
    path: 'dashboard',
    element: <DashboardPage />,
    handle: {
      breadcrumb: 'Dashboard',
      nav: {
        label: 'Dashboard',
        to: '/dashboard',
        section: 'dashboard',
        order: 11,
        description: 'Key performance indicators and metrics',
      },
    },
  },
]
