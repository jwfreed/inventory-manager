import { Navigate, createBrowserRouter } from 'react-router-dom'
import AppShell from './layout/AppShell'
import { RequireAuth } from '@shared/auth'
import LoginPage from '../pages/Login'
import type { AppRouteObject } from '@shared/routes'
import { appShellRoutes } from './routeData'
import { onboardingRoutes } from '../features/onboarding'

const shellRoutes: AppRouteObject[] = [
  { index: true, element: <Navigate to="/home" replace /> },
  ...appShellRoutes,
  { path: '*', element: <Navigate to="/not-found" replace /> },
]

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  ...onboardingRoutes.map((route) => ({
    ...route,
    element: (
      <RequireAuth>
        {route.element}
      </RequireAuth>
    ),
  })),
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
