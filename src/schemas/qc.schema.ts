import { z } from 'zod';

export const qcEventSchema = z.object({
  purchaseOrderReceiptLineId: z.string().uuid(),
  eventType: z.enum(['hold', 'accept', 'reject']),
  quantity: z.number().positive(),
  uom: z.string().min(1).max(32),
  reasonCode: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  actorType: z.enum(['user', 'system']),
  actorId: z.string().max(255).optional()
});
