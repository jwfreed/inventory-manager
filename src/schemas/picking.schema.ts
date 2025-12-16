import { z } from 'zod';

export const pickBatchSchema = z.object({
  status: z.enum(['draft', 'released', 'in_progress', 'completed', 'canceled']).optional(),
  pickType: z.enum(['single_order', 'batch']),
  notes: z.string().max(2000).optional()
});

export const pickTaskSchema = z.object({
  pickBatchId: z.string().uuid(),
  status: z.enum(['pending', 'picked', 'short', 'canceled']).optional(),
  inventoryReservationId: z.string().uuid().optional(),
  salesOrderLineId: z.string().uuid().optional(),
  itemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  fromLocationId: z.string().uuid(),
  quantityRequested: z.number().positive(),
  quantityPicked: z.number().nonnegative().optional(),
  pickedAt: z.string().optional(),
  notes: z.string().max(2000).optional()
});
