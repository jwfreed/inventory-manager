import { z } from 'zod';

export const qcEventSchema = z.object({
  purchaseOrderReceiptLineId: z.string().uuid().optional(),
  workOrderId: z.string().uuid().optional(),
  workOrderExecutionLineId: z.string().uuid().optional(),
  eventType: z.enum(['hold', 'accept', 'reject']),
  quantity: z.number().positive(),
  uom: z.string().min(1).max(32),
  overrideNegative: z.boolean().optional(),
  overrideReason: z.string().max(2000).optional(),
  reasonCode: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  actorType: z.enum(['user', 'system']),
  actorId: z.string().max(255).optional()
}).refine(data => {
  const sources = [data.purchaseOrderReceiptLineId, data.workOrderId, data.workOrderExecutionLineId].filter(Boolean);
  return sources.length === 1;
}, {
  message: "Exactly one of purchaseOrderReceiptLineId, workOrderId, or workOrderExecutionLineId must be provided."
});
