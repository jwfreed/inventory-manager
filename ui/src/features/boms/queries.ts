import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, Bom } from '../../api/types'
import { getBom, listBomsByItem, listNextStepBoms } from './api/boms'

export const bomsQueryKeys = {
  all: ['boms'] as const,
  detail: (id: string) => [...bomsQueryKeys.all, 'detail', id] as const,
  byItem: (itemId: string) => [...bomsQueryKeys.all, 'by-item', itemId] as const,
  nextStep: (itemId: string) => [...bomsQueryKeys.all, 'next-step', itemId] as const,
}

type BomOptions = Omit<UseQueryOptions<Bom, ApiError>, 'queryKey' | 'queryFn'>

type BomsByItemOptions = Omit<
  UseQueryOptions<Awaited<ReturnType<typeof listBomsByItem>>, ApiError>,
  'queryKey' | 'queryFn'
>

type NextStepBomsOptions = Omit<
  UseQueryOptions<{ data: Bom[] }, ApiError>,
  'queryKey' | 'queryFn'
>

export function useBom(id?: string, options: BomOptions = {}) {
  return useQuery({
    queryKey: bomsQueryKeys.detail(id ?? ''),
    queryFn: () => getBom(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useBomsByItem(itemId?: string, options: BomsByItemOptions = {}) {
  return useQuery({
    queryKey: bomsQueryKeys.byItem(itemId ?? ''),
    queryFn: () => listBomsByItem(itemId as string),
    enabled: Boolean(itemId),
    retry: 1,
    ...options,
  })
}

export function useNextStepBoms(itemId?: string, options: NextStepBomsOptions = {}) {
  return useQuery({
    queryKey: bomsQueryKeys.nextStep(itemId ?? ''),
    queryFn: () => listNextStepBoms(itemId as string),
    enabled: Boolean(itemId),
    retry: 1,
    ...options,
  })
}
