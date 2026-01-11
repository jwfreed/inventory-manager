import { lazy, Suspense } from 'react'
import type { AppRouteObject } from '../../shared/routes'
import { ReceivingProvider } from './context'

// Lazy load all receiving pages for code splitting
const ReceivingPage = lazy(() => import('./pages/ReceivingPage'))
const ReceiptCapturePage = lazy(() => import('./pages/ReceiptCapturePage'))
const QcClassificationPage = lazy(() => import('./pages/QcClassificationPage'))
const PutawayPlanningPage = lazy(() => import('./pages/PutawayPlanningPage'))
const QcEventDetailPage = lazy(() => import('./pages/QcEventDetailPage'))

// Loading fallback component
function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
        <p className="text-sm text-slate-500">Loading...</p>
      </div>
    </div>
  )
}

// Wrapper to add Suspense boundary with provider
function withProviderAndSuspense(Component: React.LazyExoticComponent<() => JSX.Element>) {
  return (
    <ReceivingProvider>
      <Suspense fallback={<PageLoader />}>
        <Component />
      </Suspense>
    </ReceivingProvider>
  )
}

export const receivingRoutes: AppRouteObject[] = [
  {
    path: 'receiving',
    element: withProviderAndSuspense(ReceivingPage),
    handle: {
      breadcrumb: 'Receiving & QC',
      nav: {
        label: 'Receiving & QC',
        to: '/receiving',
        section: 'inbound',
        order: 23,
        description: 'Receive goods and perform quality checks',
      },
    },
  },
  {
    path: 'receiving/receipt',
    element: withProviderAndSuspense(ReceiptCapturePage),
    handle: {
      breadcrumb: 'Receipt',
    },
  },
  {
    path: 'receiving/qc',
    element: withProviderAndSuspense(QcClassificationPage),
    handle: {
      breadcrumb: 'QC Classification',
    },
  },
  {
    path: 'receiving/putaway',
    element: withProviderAndSuspense(PutawayPlanningPage),
    handle: {
      breadcrumb: 'Putaway',
    },
  },
  {
    path: 'qc-events/:qcEventId',
    element: withProviderAndSuspense(QcEventDetailPage),
    handle: {
      breadcrumb: 'QC event',
    },
  },
]
