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
        label: 'Sales Orders',
        to: '/sales-orders',
        section: 'outbound',
        order: 50,
        description: 'Customer orders and fulfillment',
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
        label: 'Reservations',
        to: '/reservations',
        section: 'outbound',
        order: 52,
        description: 'Inventory allocations and reservations',
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
        label: 'Shipments',
        to: '/shipments',
        section: 'outbound',
        order: 54,
        description: 'Pick, pack, and ship orders',
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
        label: 'Returns',
        to: '/returns',
        section: 'outbound',
        order: 56,
        description: 'Customer returns and RMAs',
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
