import type { AppRouteObject } from '../../shared/routes'
import ReceivingPage from './pages/ReceivingPage'
import QcEventDetailPage from './pages/QcEventDetailPage'

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
  {
    path: 'qc-events/:qcEventId',
    element: <QcEventDetailPage />,
    handle: {
      breadcrumb: 'QC event',
    },
  },
]
