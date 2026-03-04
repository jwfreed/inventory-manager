import { z } from 'zod';
import { uomSchema } from './shared/uom.schema';

export const shippingContainerSchema = z.object({
  status: z.enum(['open', 'sealed', 'canceled']).optional(),
  salesOrderShipmentId: z.string().uuid().optional().nullable(),
  salesOrderId: z.string().uuid().optional().nullable(),
  packageRef: z.string().max(255).optional(),
  trackingNumber: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  items: z
    .array(
      z.object({
        pickTaskId: z.string().uuid().optional(),
        salesOrderLineId: z.string().uuid(),
        itemId: z.string().uuid(),
        uom: uomSchema.max(32),
        quantity: z.number().positive()
      }),
    )
    .optional(),
});

export const shippingContainerItemSchema = z.object({
  pickTaskId: z.string().uuid().optional(),
  salesOrderLineId: z.string().uuid(),
  itemId: z.string().uuid(),
  uom: uomSchema.max(32),
  quantity: z.number().positive(),
});
