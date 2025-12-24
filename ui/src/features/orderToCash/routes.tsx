import type { AppRouteObject } from '../../shared/routes'
import ReservationDetailPage from './pages/ReservationDetailPage'
import ReservationsListPage from './pages/ReservationsListPage'
import ReturnDetailPage from './pages/ReturnDetailPage'
import ReturnsListPage from './pages/ReturnsListPage'
import SalesOrderCreatePage from './pages/SalesOrderCreatePage'
import SalesOrderDetailPage from './pages/SalesOrderDetailPage'
import SalesOrdersListPage from './pages/SalesOrdersListPage'
import ShipmentDetailPage from './pages/ShipmentDetailPage'
import ShipmentsListPage from './pages/ShipmentsListPage'

export const orderToCashRoutes: AppRouteObject[] = [
  {
    path: 'sales-orders',
    element: <SalesOrdersListPage />,
    handle: {
      breadcrumb: 'Sales Orders',
      nav: {
        label: 'OTC — Sales Orders',
        to: '/sales-orders',
        order: 10,
      },
    },
  },
  {
    path: 'sales-orders/new',
    element: <SalesOrderCreatePage />,
    handle: {
      breadcrumb: 'New sales order',
    },
  },
  {
    path: 'sales-orders/:id',
    element: <SalesOrderDetailPage />,
    handle: {
      breadcrumb: 'Sales order',
    },
  },
  {
    path: 'reservations',
    element: <ReservationsListPage />,
    handle: {
      breadcrumb: 'Reservations',
      nav: {
        label: 'OTC — Reservations',
        to: '/reservations',
        order: 11,
      },
    },
  },
  {
    path: 'reservations/:id',
    element: <ReservationDetailPage />,
    handle: {
      breadcrumb: 'Reservation',
    },
  },
  {
    path: 'shipments',
    element: <ShipmentsListPage />,
    handle: {
      breadcrumb: 'Shipments',
      nav: {
        label: 'OTC — Shipments',
        to: '/shipments',
        order: 12,
      },
    },
  },
  {
    path: 'shipments/:id',
    element: <ShipmentDetailPage />,
    handle: {
      breadcrumb: 'Shipment',
    },
  },
  {
    path: 'returns',
    element: <ReturnsListPage />,
    handle: {
      breadcrumb: 'Returns',
      nav: {
        label: 'OTC — Returns',
        to: '/returns',
        order: 13,
      },
    },
  },
  {
    path: 'returns/:id',
    element: <ReturnDetailPage />,
    handle: {
      breadcrumb: 'Return',
    },
  },
]
