import { lazy } from 'react'
import type { AppRouteObject } from '@shared/routes'

const InventoryValuationPage = lazy(() => import('./pages/InventoryValuationPage'))
const CostVariancePage = lazy(() => import('./pages/CostVariancePage'))
const ReceiptCostAnalysisPage = lazy(() => import('./pages/ReceiptCostAnalysisPage'))
const WorkOrderProgressPage = lazy(() => import('./pages/WorkOrderProgressPage'))
const MovementTransactionsPage = lazy(() => import('./pages/MovementTransactionsPage'))
const InventoryVelocityPage = lazy(() => import('./pages/InventoryVelocityPage'))
const OpenPOAgingPage = lazy(() => import('./pages/OpenPOAgingPage'))
const SalesOrderFillPage = lazy(() => import('./pages/SalesOrderFillPage'))
const ProductionRunFrequencyPage = lazy(() => import('./pages/ProductionRunFrequencyPage'))

export const reportRoutes: AppRouteObject[] = [
  {
    path: '/reports/inventory-valuation',
    element: <InventoryValuationPage />,
    handle: {
      breadcrumb: 'Inventory Valuation',
      nav: {
        label: 'Inventory Valuation',
        to: '/reports/inventory-valuation',
        section: 'reports',
        order: 62,
        description: 'On-hand value by location and item',
      },
    },
  },
  {
    path: '/reports/cost-variance',
    element: <CostVariancePage />,
    handle: {
      breadcrumb: 'Cost Variance',
      nav: {
        label: 'Cost Variance',
        to: '/reports/cost-variance',
        section: 'reports',
        order: 64,
        description: 'Standard vs actual cost analysis',
      },
    },
  },
  {
    path: '/reports/receipt-cost-analysis',
    element: <ReceiptCostAnalysisPage />,
    handle: {
      breadcrumb: 'Receipt Cost Analysis',
      nav: {
        label: 'Receipt Cost Analysis',
        to: '/reports/receipt-cost-analysis',
        section: 'reports',
        order: 65,
        description: 'PO vs receipt cost comparison',
      },
    },
  },
  {
    path: '/reports/work-order-progress',
    element: <WorkOrderProgressPage />,
    handle: {
      breadcrumb: 'Work Order Progress',
      nav: {
        label: 'Work Order Progress',
        to: '/reports/work-order-progress',
        section: 'reports',
        order: 66,
        description: 'Production completion and late orders',
      },
    },
  },
  {
    path: '/reports/movement-transactions',
    element: <MovementTransactionsPage />,
    handle: {
      breadcrumb: 'Movement Transactions',
      nav: {
        label: 'Movement Transactions',
        to: '/reports/movement-transactions',
        section: 'reports',
        order: 67,
        description: 'Inventory movement audit trail',
      },
    },
  },
  {
    path: '/reports/inventory-velocity',
    element: <InventoryVelocityPage />,
    handle: {
      breadcrumb: 'Inventory Velocity',
      nav: {
        label: 'Inventory Velocity',
        to: '/reports/inventory-velocity',
        section: 'reports',
        order: 68,
        description: 'Turnover and movement frequency',
      },
    },
  },
  {
    path: '/reports/open-po-aging',
    element: <OpenPOAgingPage />,
    handle: {
      breadcrumb: 'Open PO Aging',
      nav: {
        label: 'Open PO Aging',
        to: '/reports/open-po-aging',
        section: 'reports',
        order: 69,
        description: 'Outstanding purchase orders',
      },
    },
  },
  {
    path: '/reports/sales-order-fill',
    element: <SalesOrderFillPage />,
    handle: {
      breadcrumb: 'Sales Order Fill',
      nav: {
        label: 'Sales Order Fill',
        to: '/reports/sales-order-fill',
        section: 'reports',
        order: 70,
        description: 'Order fulfillment performance',
      },
    },
  },
  {
    path: '/reports/production-frequency',
    element: <ProductionRunFrequencyPage />,
    handle: {
      breadcrumb: 'Production Frequency',
      nav: {
        label: 'Production Frequency',
        to: '/reports/production-frequency',
        section: 'reports',
        order: 71,
        description: 'Batch sizes and run frequency',
      },
    },
  },
]
