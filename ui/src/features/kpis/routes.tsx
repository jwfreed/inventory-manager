import type { AppRouteObject } from '../../shared/routes'
import DashboardPage from './pages/DashboardPage'

export const kpiRoutes: AppRouteObject[] = [
  {
    path: 'dashboard',
    element: <DashboardPage />,
    handle: {
      breadcrumb: 'Dashboard',
      nav: {
        label: 'KPI Dashboard',
        to: '/dashboard',
        section: 'reports',
        order: 60,
        description: 'Key performance indicators and metrics',
      },
    },
  },
]
