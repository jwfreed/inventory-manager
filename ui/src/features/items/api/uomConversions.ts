import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiDelete } from '../../../api/http';
import type { UomConversion } from '../../../api/types';
import { itemsQueryKeys } from '../queries';

export async function listUomConversions(itemId: string): Promise<UomConversion[]> {
  return apiGet(`/items/${itemId}/uom-conversions`);
}

export async function createUomConversion(payload: Omit<UomConversion, 'id' | 'createdAt' | 'updatedAt'>): Promise<UomConversion> {
  return apiPost(`/items/${payload.itemId}/uom-conversions`, payload);
}

export async function deleteUomConversion(id: string): Promise<void> {
  return apiDelete(`/uom-conversions/${id}`);
}

export function useUomConversionsList(itemId?: string) {
  return useQuery({
    queryKey: ['uom-conversions', itemId],
    queryFn: () => listUomConversions(itemId as string),
    enabled: !!itemId,
  });
}

export function useCreateUomConversion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createUomConversion,
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['uom-conversions', variables.itemId] });
      void queryClient.invalidateQueries({ queryKey: itemsQueryKeys.detail(variables.itemId) });
    },
  });
}

export function useDeleteUomConversion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteUomConversion,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['uom-conversions'] });
      void queryClient.invalidateQueries({ queryKey: itemsQueryKeys.all });
    },
  });
}
