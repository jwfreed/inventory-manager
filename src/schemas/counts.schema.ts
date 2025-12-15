import { z } from 'zod';

export const countLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  itemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  countedQuantity: z.number().min(0),
  notes: z.string().max(2000).optional()
});

export const inventoryCountSchema = z.object({
  countedAt: z.string().datetime(),
  locationId: z.string().uuid(),
  notes: z.string().max(2000).optional(),
  lines: z.array(countLineSchema).min(1)
});
