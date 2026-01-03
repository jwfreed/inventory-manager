import { lazy } from 'react'
import type { AppRouteObject } from '@shared/routes'

const InventoryValuationPage = lazy(() => import('./pages/InventoryValuationPage'))
const CostVariancePage = lazy(() => import('./pages/CostVariancePage'))
const ReceiptCostAnalysisPage = lazy(() => import('./pages/ReceiptCostAnalysisPage'))

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
]
