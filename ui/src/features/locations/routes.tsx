import type { AppRouteObject } from '../../shared/routes'
import LocationDetailPage from './pages/LocationDetailPage'
import LocationsListPage from './pages/LocationsListPage'

export const locationRoutes: AppRouteObject[] = [
  {
    path: 'locations',
    element: <LocationsListPage />,
    handle: {
      breadcrumb: 'Locations',
      nav: {
        label: 'Locations',
        to: '/locations',
        section: 'master-data',
        order: 72,
        description: 'Warehouse and storage location hierarchy',
      },
    },
  },
  {
    path: 'locations/:id',
    element: <LocationDetailPage />,
    handle: {
      breadcrumb: 'Location',
    },
  },
]
