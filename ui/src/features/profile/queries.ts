import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError } from '../../api/types'
import { getProfile, type ProfileResponse } from './api/profile'

export const profileQueryKeys = {
  all: ['profile'] as const,
  detail: () => [...profileQueryKeys.all, 'detail'] as const,
}

type ProfileOptions = Omit<UseQueryOptions<ProfileResponse, ApiError>, 'queryKey' | 'queryFn'>

export function useProfile(options: ProfileOptions = {}) {
  return useQuery({
    queryKey: profileQueryKeys.detail(),
    queryFn: () => getProfile(),
    retry: 1,
    ...options,
  })
}
