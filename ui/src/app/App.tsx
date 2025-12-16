import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom'
import AppShell from './layout/AppShell'
import HomePage from '../pages/Home'
import NotFoundPage from '../pages/NotFound'
import MovementsListPage from '../features/ledger/pages/MovementsListPage'
import MovementDetailPage from '../features/ledger/pages/MovementDetailPage'

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/home" replace /> },
      { path: 'home', element: <HomePage /> },
      { path: 'ledger/movements', element: <MovementsListPage /> },
      { path: 'ledger/movements/:movementId', element: <MovementDetailPage /> },
      { path: 'not-found', element: <NotFoundPage /> },
      { path: '*', element: <Navigate to="/not-found" replace /> },
    ],
  },
])

function App() {
  return <RouterProvider router={router} />
}

export default App
