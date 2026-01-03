import type { AppRouteObject } from '../../shared/routes'
import NcrListPage from './pages/NcrListPage'
import NcrDetailPage from './pages/NcrDetailPage'

export const ncrRoutes: AppRouteObject[] = [
  {
    path: 'ncrs',
    handle: {
      breadcrumb: 'NCRs',
      nav: {
        label: 'Non-Conformance Reports',
        to: '/ncrs',
        section: 'reports',
        order: 66,
        description: 'Quality issues and corrective actions',
      },
    },
    children: [
      {
        index: true,
        element: <NcrListPage />,
      },
      {
        path: ':id',
        element: <NcrDetailPage />,
        handle: {
          breadcrumb: 'NCR Details',
        },
      },
    ],
  },
]
