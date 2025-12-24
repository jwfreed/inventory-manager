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
        order: 9,
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
