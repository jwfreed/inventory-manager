import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from '@shared/auth'
import { useServerEvents } from '@lib/useServerEvents'
import { useInventoryChangesPolling } from '@lib/useInventoryChangesPolling'

type Props = {
  children: ReactNode
}

export function AppProviders({ children }: Props) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  )

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <ServerEventsListener />
        {children}
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </AuthProvider>
  )
}

function ServerEventsListener() {
  const { status, accessToken, tenant } = useAuth()
  useServerEvents(status === 'authenticated' ? accessToken : null)
  useInventoryChangesPolling(status === 'authenticated', tenant?.id)
  return null
}
