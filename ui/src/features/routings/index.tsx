import type { RouteObject } from 'react-router-dom';
import { WorkCentersPage } from './pages/WorkCentersPage';

export const routingsRoutes: RouteObject[] = [
  {
    path: 'work-centers',
    element: <WorkCentersPage />,
    handle: {
      breadcrumb: 'Work Centers',
      nav: {
        label: 'Work Centers',
        to: '/work-centers',
        order: 11,
      },
    },
  },
];
