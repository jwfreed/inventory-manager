import { apiGet, apiPost, apiPatch } from '../../api/http';
import type { WorkCenter, Routing } from './types';

export const getWorkCenters = async (): Promise<WorkCenter[]> => {
  return apiGet<WorkCenter[]>('/work-centers');
};

export const getWorkCenter = async (id: string): Promise<WorkCenter> => {
  return apiGet<WorkCenter>(`/work-centers/${id}`);
};

export const createWorkCenter = async (workCenter: Partial<WorkCenter>): Promise<WorkCenter> => {
  return apiPost<WorkCenter>('/work-centers', workCenter);
};

export const updateWorkCenter = async (id: string, workCenter: Partial<WorkCenter>): Promise<WorkCenter> => {
  return apiPatch<WorkCenter>(`/work-centers/${id}`, workCenter);
};

export const getRoutingsByItemId = async (itemId: string): Promise<Routing[]> => {
  return apiGet<Routing[]>(`/items/${itemId}/routings`);
};

export const getRouting = async (id: string): Promise<Routing> => {
  return apiGet<Routing>(`/routings/${id}`);
};

export const createRouting = async (routing: Partial<Routing>): Promise<Routing> => {
  return apiPost<Routing>('/routings', routing);
};

export const updateRouting = async (id: string, routing: Partial<Routing>): Promise<Routing> => {
  return apiPatch<Routing>(`/routings/${id}`, routing);
};
