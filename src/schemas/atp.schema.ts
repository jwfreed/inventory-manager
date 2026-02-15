import { z } from 'zod';

export const atpQuerySchema = z.object({
  warehouseId: z.string().uuid(),
  itemId: z.string().uuid().optional().or(z.literal('')).transform(v => v === '' ? undefined : v),
  locationId: z.string().uuid().optional().or(z.literal('')).transform(v => v === '' ? undefined : v),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

export const atpDetailQuerySchema = z.object({
  warehouseId: z.string().uuid(),
  itemId: z.string().uuid(),
  locationId: z.string().uuid(),
  uom: z.string().min(1).max(32).optional()
});

export const atpCheckSchema = z.object({
  warehouseId: z.string().uuid(),
  itemId: z.string().uuid(),
  locationId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantity: z.number().positive()
});
