import { z } from 'zod';

const isoDateTimeString = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
    'Use ISO timestamp'
  );

export const inventoryTransferCreateSchema = z.object({
  sourceLocationId: z.string().uuid(),
  destinationLocationId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.number().positive(),
  uom: z.string().min(1).max(32),
  occurredAt: isoDateTimeString.optional(),
  reasonCode: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  overrideNegative: z.boolean().optional(),
  overrideReason: z.string().max(2000).optional()
});
