import type { AppRouteObject } from '../../shared/routes'
import ReceivingPage from './pages/ReceivingPage'
import QcEventDetailPage from './pages/QcEventDetailPage'

export const receivingRoutes: AppRouteObject[] = [
  {
    path: 'receiving',
    element: <ReceivingPage />,
    handle: {
      breadcrumb: 'Receiving & QC',
      nav: {
        label: 'Receiving & QC',
        to: '/receiving',
        section: 'inbound',
        order: 23,
        description: 'Receive goods and perform quality checks',
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
