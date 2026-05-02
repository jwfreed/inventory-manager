import { lazy } from 'react'
import type { AppRouteObject } from '../../shared/routes'

const ApDashboardPage = lazy(() => import('./pages/ApDashboardPage'))
const InvoiceListPage = lazy(() => import('./pages/InvoiceListPage'))
const InvoiceDetailPage = lazy(() => import('./pages/InvoiceDetailPage'))
const InvoiceCreatePage = lazy(() => import('./pages/InvoiceCreatePage'))
const PaymentListPage = lazy(() => import('./pages/PaymentListPage'))
const PaymentDetailPage = lazy(() => import('./pages/PaymentDetailPage'))
const PaymentCreatePage = lazy(() => import('./pages/PaymentCreatePage'))

export const apRoutes: AppRouteObject[] = [
  {
    path: 'ap',
    handle: {
      breadcrumb: 'Accounts Payable',
      permission: 'finance:read',
      nav: {
        label: 'Accounts Payable',
        to: '/ap',
        section: 'master-data',
        order: 75,
        description: 'Vendor invoices and payments',
      },
    },
    children: [
      {
        index: true,
        element: <ApDashboardPage />,
        handle: {
          breadcrumb: 'Dashboard',
          permission: 'finance:read',
        },
      },
      {
        path: 'invoices',
        handle: {
          breadcrumb: 'Invoices',
          permission: 'finance:read',
        },
        children: [
          {
            index: true,
            element: <InvoiceListPage />,
          },
          {
            path: 'create',
            element: <InvoiceCreatePage />,
            handle: {
              breadcrumb: 'Create',
              permission: 'finance:write',
            },
          },
          {
            path: ':id',
            element: <InvoiceDetailPage />,
            handle: {
              breadcrumb: 'Details',
              permission: 'finance:read',
            },
          },
        ],
      },
      {
        path: 'payments',
        handle: {
          breadcrumb: 'Payments',
          permission: 'finance:read',
        },
        children: [
          {
            index: true,
            element: <PaymentListPage />,
          },
          {
            path: 'create',
            element: <PaymentCreatePage />,
            handle: {
              breadcrumb: 'Create',
              permission: 'finance:write',
            },
          },
          {
            path: ':id',
            element: <PaymentDetailPage />,
            handle: {
              breadcrumb: 'Details',
              permission: 'finance:read',
            },
          },
        ],
      },
    ],
  },
]
