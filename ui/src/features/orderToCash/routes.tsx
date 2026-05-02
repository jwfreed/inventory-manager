import type { AppRouteObject } from '../../shared/routes'
import ReservationDetailPage from './pages/ReservationDetailPage'
import ReservationsListPage from './pages/ReservationsListPage'
import ReturnAuthorizationPage from './pages/ReturnAuthorizationPage'
import ReturnDetailPage from './pages/ReturnDetailPage'
import ReturnReceiptPage from './pages/ReturnReceiptPage'
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
      permission: 'outbound:read',
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
      permission: 'outbound:write',
    },
  },
  {
    path: 'sales-orders/:id',
    element: <SalesOrderDetailPage />,
    handle: {
      breadcrumb: 'Sales order',
      permission: 'outbound:read',
    },
  },
  {
    path: 'reservations',
    element: <ReservationsListPage />,
    handle: {
      breadcrumb: 'Reservations',
      permission: 'outbound:read',
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
      permission: 'outbound:read',
    },
  },
  {
    path: 'shipments',
    element: <ShipmentsListPage />,
    handle: {
      breadcrumb: 'Shipments',
      permission: 'outbound:read',
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
      permission: 'outbound:read',
    },
  },
  {
    path: 'returns',
    element: <ReturnsListPage />,
    handle: {
      breadcrumb: 'Returns',
      permission: 'outbound:read',
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
    path: 'returns/new',
    element: <ReturnAuthorizationPage />,
    handle: {
      breadcrumb: 'New return authorization',
      permission: 'outbound:write',
    },
  },
  {
    path: 'returns/:id',
    element: <ReturnDetailPage />,
    handle: {
      breadcrumb: 'Return',
      permission: 'outbound:read',
    },
  },
  {
    path: 'return-receipts/:id',
    element: <ReturnReceiptPage />,
    handle: {
      breadcrumb: 'Return receipt',
      permission: 'outbound:read',
    },
  },
]
