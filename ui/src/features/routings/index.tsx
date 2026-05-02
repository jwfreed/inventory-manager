import type { AppRouteObject } from '../../shared/routes'
import { WorkCentersPage } from './pages/WorkCentersPage'

export const routingsRoutes: AppRouteObject[] = [
  {
    path: 'work-centers',
    element: <WorkCentersPage />,
    handle: {
      breadcrumb: 'Production Areas',
      permission: 'production:read',
      nav: {
        label: 'Production Areas',
        to: '/work-centers',
        section: 'master-data',
        order: 74,
        description: 'Used to group production records and filter reports.',
      },
    },
  },
]
