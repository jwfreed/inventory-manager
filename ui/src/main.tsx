import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import { AppProviders } from './app/providers'
import { ErrorBoundary } from './components/ErrorBoundary'
import ErrorFallback from './components/ErrorFallback'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary
      fallbackRender={(state) => (
        <ErrorFallback
          errorId={state.errorId}
          error={state.error}
          componentStack={state.componentStack}
          onGoHome={() => window.location.assign('/')}
        />
      )}
    >
      <AppProviders>
        <App />
      </AppProviders>
    </ErrorBoundary>
  </StrictMode>,
)
