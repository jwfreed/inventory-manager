import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from '../lib/auth'
import { useServerEvents } from '../lib/useServerEvents'

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
  const { status, accessToken } = useAuth()
  useServerEvents(status === 'authenticated' ? accessToken : null)
  return null
}
