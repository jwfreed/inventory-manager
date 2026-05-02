import type { AppRouteObject } from '../../shared/routes'
import { AtpQueryPage } from './pages/AtpQueryPage'
import InventoryCountCreatePage from './pages/InventoryCountCreatePage'
import InventoryCountDetailPage from './pages/InventoryCountDetailPage'
import { InventoryCountsListPage } from './pages/InventoryCountsListPage'
import InventoryOperationsDashboardPage from './pages/InventoryOperationsDashboardPage'
import { InventoryTransferCreatePage } from './pages/InventoryTransferCreatePage'
import { LicensePlatesPage } from './pages/LicensePlatesPage'
import WarehouseActivityBoardPage from './pages/WarehouseActivityBoardPage'

export const atpRoutes: AppRouteObject[] = [
  {
    path: 'atp',
    element: <AtpQueryPage />,
    handle: {
      breadcrumb: 'Available to Promise',
      permission: 'inventory:read',
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
      permission: 'inventory:read',
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
      permission: 'inventory:transfers:write',
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
    path: 'inventory/operations',
    element: <InventoryOperationsDashboardPage />,
    handle: {
      breadcrumb: 'Inventory Operations',
      permission: 'inventory:read',
      nav: {
        label: 'Inventory Operations',
        to: '/inventory/operations',
        section: 'inventory',
        order: 38,
        description: 'Latest operational activity across warehouse workflows',
      },
    },
  },
  {
    path: 'inventory/activity',
    element: <WarehouseActivityBoardPage />,
    handle: {
      breadcrumb: 'Warehouse Activity',
      permission: 'inventory:read',
      nav: {
        label: 'Warehouse Activity',
        to: '/inventory/activity',
        section: 'inventory',
        order: 37,
        description: 'Latest warehouse execution activity across outbound and production workflows',
      },
    },
  },
  {
    path: 'inventory-counts',
    element: <InventoryCountsListPage />,
    handle: {
      breadcrumb: 'Inventory Counts',
      permission: 'inventory:read',
      nav: {
        label: 'Inventory Counts',
        to: '/inventory-counts',
        section: 'inventory',
        order: 39,
        description: 'Create and post warehouse cycle counts',
      },
    },
  },
  {
    path: 'inventory-counts/new',
    element: <InventoryCountCreatePage />,
    handle: {
      breadcrumb: 'New inventory count',
      permission: 'inventory:counts:write',
    },
  },
  {
    path: 'inventory-counts/:id',
    element: <InventoryCountDetailPage />,
    handle: {
      breadcrumb: 'Inventory count',
      permission: 'inventory:read',
    },
  },
]
