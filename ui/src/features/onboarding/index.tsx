import type { AppRouteObject } from '../../shared/routes'
import OnboardingLayout from './components/OnboardingLayout'
import WelcomePage from './pages/WelcomePage'
import AccountSetupPage from './pages/AccountSetupPage'
import ContextPage from './pages/ContextPage'
import FirstWinPage from './pages/FirstWinPage'
import ChecklistPage from './pages/ChecklistPage'
import DonePage from './pages/DonePage'

export const onboardingRoutes: AppRouteObject[] = [
  {
    path: 'onboarding',
    element: <OnboardingLayout />,
    children: [
      { index: true, element: <WelcomePage /> },
      { path: 'welcome', element: <WelcomePage /> },
      { path: 'account', element: <AccountSetupPage /> },
      { path: 'context', element: <ContextPage /> },
      { path: 'first-win', element: <FirstWinPage /> },
      { path: 'checklist', element: <ChecklistPage /> },
      { path: 'done', element: <DonePage /> },
    ],
  },
]
