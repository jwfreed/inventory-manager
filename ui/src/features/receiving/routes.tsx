import type { AppRouteObject } from '../../shared/routes'
import ReceivingPage from './pages/ReceivingPage'

export const receivingRoutes: AppRouteObject[] = [
  {
    path: 'receiving',
    element: <ReceivingPage />,
    handle: {
      breadcrumb: 'Receiving & putaway',
      nav: {
        label: 'Receiving & putaway',
        to: '/receiving',
        order: 7,
      },
    },
  },
]
