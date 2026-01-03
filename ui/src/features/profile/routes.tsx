import type { AppRouteObject } from '../../shared/routes'
import ProfilePage from './pages/ProfilePage'

export const profileRoutes: AppRouteObject[] = [
  {
    path: 'profile',
    element: <ProfilePage />,
    handle: {
      breadcrumb: 'Profile',
      nav: {
        label: 'Profile',
        to: '/profile',
        section: 'profile',
        order: 90,
        description: 'User settings and preferences',
      },
    },
  },
]
