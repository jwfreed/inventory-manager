import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, Movement, MovementLine } from '../../api/types'
import { getMovement, getMovementLines, listMovements, type MovementListParams } from './api/ledger'

export const ledgerQueryKeys = {
  all: ['movements'] as const,
  list: (params: MovementListParams = {}) => [...ledgerQueryKeys.all, 'list', params] as const,
  detail: (id: string) => [...ledgerQueryKeys.all, 'detail', id] as const,
  lines: (movementId: string) => [...ledgerQueryKeys.all, 'lines', movementId] as const,
}

type MovementsListOptions = Omit<
  UseQueryOptions<Awaited<ReturnType<typeof listMovements>>, ApiError>,
  'queryKey' | 'queryFn'
>

type MovementOptions = Omit<UseQueryOptions<Movement, ApiError>, 'queryKey' | 'queryFn'>

type MovementLinesOptions = Omit<
  UseQueryOptions<MovementLine[], ApiError>,
  'queryKey' | 'queryFn'
>

export function useMovementsList(params: MovementListParams = {}, options: MovementsListOptions = {}) {
  return useQuery({
    queryKey: ledgerQueryKeys.list(params),
    queryFn: () => listMovements(params),
    retry: 1,
    ...options,
  })
}

export function useMovement(id?: string, options: MovementOptions = {}) {
  return useQuery({
    queryKey: ledgerQueryKeys.detail(id ?? ''),
    queryFn: () => getMovement(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useMovementLines(movementId?: string, options: MovementLinesOptions = {}) {
  return useQuery({
    queryKey: ledgerQueryKeys.lines(movementId ?? ''),
    queryFn: () => getMovementLines(movementId as string),
    enabled: Boolean(movementId),
    retry: 1,
    ...options,
  })
}
