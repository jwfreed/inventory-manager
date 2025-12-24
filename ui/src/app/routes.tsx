import { Navigate, createBrowserRouter } from 'react-router-dom'
import AppShell from './layout/AppShell'
import { RequireAuth } from '../lib/auth'
import LoginPage from '../pages/Login'
import type { AppRouteObject } from '../shared/routes'
import { appShellRoutes } from './routeData'

const shellRoutes: AppRouteObject[] = [
  { index: true, element: <Navigate to="/home" replace /> },
  ...appShellRoutes,
  { path: '*', element: <Navigate to="/not-found" replace /> },
]

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: shellRoutes,
  },
])
