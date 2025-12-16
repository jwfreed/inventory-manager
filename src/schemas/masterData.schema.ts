import { z } from 'zod';

export const itemSchema = z.object({
  sku: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  active: z.boolean().optional()
});

export const locationSchema = z.object({
  code: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  type: z.enum(['warehouse', 'bin', 'store', 'customer', 'vendor', 'scrap', 'virtual']),
  active: z.boolean().optional(),
  parentLocationId: z.string().uuid().nullable().optional()
});
