import { lazy } from 'react'
import type { AppRouteObject } from '@shared/routes'

const InventoryValuationPage = lazy(() => import('./pages/InventoryValuationPage'))
const CostVariancePage = lazy(() => import('./pages/CostVariancePage'))
const ReceiptCostAnalysisPage = lazy(() => import('./pages/ReceiptCostAnalysisPage'))

export const reportRoutes: AppRouteObject[] = [
  {
    path: '/reports/inventory-valuation',
    element: <InventoryValuationPage />,
  },
  {
    path: '/reports/cost-variance',
    element: <CostVariancePage />,
  },
  {
    path: '/reports/receipt-cost-analysis',
    element: <ReceiptCostAnalysisPage />,
  },
]
