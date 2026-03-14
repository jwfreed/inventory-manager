import type { AppRouteObject } from '../../shared/routes'
import { AtpQueryPage } from './pages/AtpQueryPage'
import InventoryCountCreatePage from './pages/InventoryCountCreatePage'
import InventoryCountDetailPage from './pages/InventoryCountDetailPage'
import { InventoryCountsListPage } from './pages/InventoryCountsListPage'
import { InventoryTransferCreatePage } from './pages/InventoryTransferCreatePage'
import { LicensePlatesPage } from './pages/LicensePlatesPage'

export const atpRoutes: AppRouteObject[] = [
  {
    path: 'atp',
    element: <AtpQueryPage />,
    handle: {
      breadcrumb: 'Available to Promise',
      nav: {
        label: 'Available-to-Promise',
        to: '/atp',
        section: 'inventory',
        order: 35,
        description: 'Check inventory availability for orders',
      },
    },
  },
  {
    path: 'lpns',
    element: <LicensePlatesPage />,
    handle: {
      breadcrumb: 'License Plates',
      nav: {
        label: 'License Plates',
        to: '/lpns',
        section: 'inventory',
        order: 34,
        description: 'Manage license plate tracking',
      },
    },
  },
  {
    path: 'inventory-transfers/new',
    element: <InventoryTransferCreatePage />,
    handle: {
      breadcrumb: 'Inventory Transfer',
      nav: {
        label: 'Inventory Transfers',
        to: '/inventory-transfers/new',
        section: 'inventory',
        order: 36,
        description: 'Post direct inventory transfers',
      },
    },
  },
  {
    path: 'inventory-counts',
    element: <InventoryCountsListPage />,
    handle: {
      breadcrumb: 'Inventory Counts',
      nav: {
        label: 'Inventory Counts',
        to: '/inventory-counts',
        section: 'inventory',
        order: 37,
        description: 'Create and post warehouse cycle counts',
      },
    },
  },
  {
    path: 'inventory-counts/new',
    element: <InventoryCountCreatePage />,
    handle: {
      breadcrumb: 'New inventory count',
    },
  },
  {
    path: 'inventory-counts/:id',
    element: <InventoryCountDetailPage />,
    handle: {
      breadcrumb: 'Inventory count',
    },
  },
]
