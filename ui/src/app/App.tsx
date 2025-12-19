import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom'
import AppShell from './layout/AppShell'
import HomePage from '../pages/Home'
import NotFoundPage from '../pages/NotFound'
import MovementsListPage from '../features/ledger/pages/MovementsListPage'
import MovementDetailPage from '../features/ledger/pages/MovementDetailPage'
import DashboardPage from '../features/kpis/pages/DashboardPage'
import WorkOrdersListPage from '../features/workOrders/pages/WorkOrdersListPage'
import WorkOrderDetailPage from '../features/workOrders/pages/WorkOrderDetailPage'
import WorkOrderCreatePage from '../features/workOrders/pages/WorkOrderCreatePage'
import ItemsListPage from '../features/items/pages/ItemsListPage'
import ItemDetailPage from '../features/items/pages/ItemDetailPage'
import LocationsListPage from '../features/locations/pages/LocationsListPage'
import LocationDetailPage from '../features/locations/pages/LocationDetailPage'
import ReceivingPage from '../features/receiving/pages/ReceivingPage'
import SalesOrdersListPage from '../features/orderToCash/pages/SalesOrdersListPage'
import SalesOrderDetailPage from '../features/orderToCash/pages/SalesOrderDetailPage'
import SalesOrderCreatePage from '../features/orderToCash/pages/SalesOrderCreatePage'
import ReservationsListPage from '../features/orderToCash/pages/ReservationsListPage'
import ReservationDetailPage from '../features/orderToCash/pages/ReservationDetailPage'
import ShipmentsListPage from '../features/orderToCash/pages/ShipmentsListPage'
import ShipmentDetailPage from '../features/orderToCash/pages/ShipmentDetailPage'
import ReturnsListPage from '../features/orderToCash/pages/ReturnsListPage'
import ReturnDetailPage from '../features/orderToCash/pages/ReturnDetailPage'
import PurchaseOrderCreatePage from '../features/purchaseOrders/pages/PurchaseOrderCreatePage'
import VendorsListPage from '../features/vendors/pages/VendorsListPage'

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/home" replace /> },
      { path: 'home', element: <HomePage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'ledger/movements', element: <MovementsListPage /> },
      { path: 'ledger/movements/:movementId', element: <MovementDetailPage /> },
      { path: 'work-orders', element: <WorkOrdersListPage /> },
      { path: 'work-orders/new', element: <WorkOrderCreatePage /> },
      { path: 'work-orders/:id', element: <WorkOrderDetailPage /> },
      { path: 'items', element: <ItemsListPage /> },
      { path: 'items/:id', element: <ItemDetailPage /> },
      { path: 'receiving', element: <ReceivingPage /> },
      { path: 'purchase-orders/new', element: <PurchaseOrderCreatePage /> },
      { path: 'locations', element: <LocationsListPage /> },
      { path: 'locations/:id', element: <LocationDetailPage /> },
      { path: 'vendors', element: <VendorsListPage /> },
      { path: 'sales-orders', element: <SalesOrdersListPage /> },
      { path: 'sales-orders/new', element: <SalesOrderCreatePage /> },
      { path: 'sales-orders/:id', element: <SalesOrderDetailPage /> },
      { path: 'reservations', element: <ReservationsListPage /> },
      { path: 'reservations/:id', element: <ReservationDetailPage /> },
      { path: 'shipments', element: <ShipmentsListPage /> },
      { path: 'shipments/:id', element: <ShipmentDetailPage /> },
      { path: 'returns', element: <ReturnsListPage /> },
      { path: 'returns/:id', element: <ReturnDetailPage /> },
      { path: 'not-found', element: <NotFoundPage /> },
      { path: '*', element: <Navigate to="/not-found" replace /> },
    ],
  },
])

function App() {
  return <RouterProvider router={router} />
}

export default App
