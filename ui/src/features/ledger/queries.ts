import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, Movement, MovementLine, MovementWindow } from '../../api/types'
import {
  getMovement,
  getMovementLines,
  getMovementWindow,
  listMovements,
  type MovementListParams,
} from './api/ledger'

export const ledgerQueryKeys = {
  all: ['movements'] as const,
  list: (params: MovementListParams = {}) => [...ledgerQueryKeys.all, 'list', params] as const,
  detail: (id: string) => [...ledgerQueryKeys.all, 'detail', id] as const,
  lines: (movementId: string) => [...ledgerQueryKeys.all, 'lines', movementId] as const,
  window: (params: { itemId?: string; locationId?: string }) =>
    [...ledgerQueryKeys.all, 'window', params] as const,
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

type MovementWindowOptions = Omit<
  UseQueryOptions<MovementWindow | null, ApiError>,
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

export function useMovementWindow(
  params: { itemId?: string; locationId?: string },
  options: MovementWindowOptions = {},
) {
  return useQuery({
    queryKey: ledgerQueryKeys.window(params),
    queryFn: () => getMovementWindow(params),
    enabled: Boolean(params.itemId || params.locationId),
    retry: 1,
    ...options,
  })
}
