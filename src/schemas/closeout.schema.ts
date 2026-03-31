import { z } from 'zod';

export const receiptCloseSchema = z
  .object({
    actorType: z.enum(['user', 'system']).optional(),
    actorId: z.string().max(255).optional(),
    closeoutReasonCode: z.string().max(255).optional(),
    notes: z.string().max(2000).optional(),
    physicalCounts: z.array(
      z.object({
        purchaseOrderReceiptLineId: z.string().uuid(),
        locationId: z.string().uuid(),
        binId: z.string().uuid(),
        countedQty: z.number().nonnegative(),
        toleranceQty: z.number().nonnegative().optional(),
        allocationStatus: z.enum(['QA', 'AVAILABLE', 'HOLD']).optional()
      })
    ).optional(),
    resolution: z.object({
      mode: z.enum(['approval', 'adjustment']),
      notes: z.string().max(2000).optional()
    }).optional()
  })
  .superRefine((data, ctx) => {
    if (data.actorId && !data.actorType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'actorType is required when actorId is provided',
        path: ['actorType']
      });
    }
  });

export const poCloseSchema = z.object({
  notes: z.string().max(2000).optional()
});
