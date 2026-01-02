import { z } from 'zod';

export const atpQuerySchema = z.object({
  itemId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

export const atpDetailQuerySchema = z.object({
  itemId: z.string().uuid(),
  locationId: z.string().uuid(),
  uom: z.string().min(1).max(32).optional()
});

export const atpCheckSchema = z.object({
  itemId: z.string().uuid(),
  locationId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantity: z.number().positive()
});
