import { Navigate, createBrowserRouter } from 'react-router-dom'
import AppShell from './layout/AppShell'
import { RequireAuth, RequirePermission } from '@shared/auth'
import LoginPage from '../pages/Login'
import type { AppRouteObject } from '@shared/routes'
import { appShellRoutes } from './routeData'
import { onboardingRoutes } from '../features/onboarding'

function applyPermissionGuard(route: AppRouteObject, inheritedPermission?: string): AppRouteObject {
  const permission = route.handle?.permission ?? inheritedPermission
  return {
    ...route,
    element:
      permission && route.element
        ? <RequirePermission permission={permission}>{route.element}</RequirePermission>
        : route.element,
    children: route.children?.map((child) => applyPermissionGuard(child, permission)),
  }
}

const shellRoutes: AppRouteObject[] = [
  { index: true, element: <Navigate to="/dashboard" replace /> },
  ...appShellRoutes.map(applyPermissionGuard),
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
