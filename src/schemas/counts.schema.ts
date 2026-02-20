import { z } from 'zod';

export const countLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  itemId: z.string().uuid(),
  locationId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  countedQuantity: z.number().min(0),
  unitCostForPositiveAdjustment: z.number().nonnegative().optional(),
  reasonCode: z.string().min(1).max(255).optional(),
  notes: z.string().max(2000).optional()
});

export const inventoryCountSchema = z.object({
  countedAt: z.string().datetime(),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
  counterId: z.string().uuid().optional(),
  approvedBy: z.string().uuid().optional(),
  approvedAt: z.string().datetime().optional(),
  lines: z.array(countLineSchema).min(1)
});

export const inventoryCountUpdateSchema = z.object({
  countedAt: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(countLineSchema).min(1).optional()
});
