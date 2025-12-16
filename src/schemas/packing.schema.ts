import { z } from 'zod';

export const packSchema = z.object({
  status: z.enum(['open', 'sealed', 'canceled']).optional(),
  salesOrderShipmentId: z.string().uuid(),
  packageRef: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  lines: z
    .array(
      z.object({
        pickTaskId: z.string().uuid().optional(),
        salesOrderLineId: z.string().uuid(),
        itemId: z.string().uuid(),
        uom: z.string().min(1).max(32),
        quantityPacked: z.number().positive()
      }),
    )
    .optional(),
});

export const packLineSchema = z.object({
  pickTaskId: z.string().uuid().optional(),
  salesOrderLineId: z.string().uuid(),
  itemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityPacked: z.number().positive(),
});
