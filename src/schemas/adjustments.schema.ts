import { z } from 'zod';

export const adjustmentLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  itemId: z.string().uuid(),
  locationId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityDelta: z.number().refine((value) => value !== 0, { message: 'quantityDelta must be non-zero' }),
  reasonCode: z.string().min(1).max(255),
  notes: z.string().max(2000).optional()
});

export const inventoryAdjustmentSchema = z.object({
  occurredAt: z.string().datetime(),
  correctedFromAdjustmentId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(adjustmentLineSchema).min(1)
});

export const adjustmentListQuerySchema = z.object({
  status: z.string().optional(),
  occurred_from: z.string().optional(),
  occurred_to: z.string().optional(),
  item_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional()
});
