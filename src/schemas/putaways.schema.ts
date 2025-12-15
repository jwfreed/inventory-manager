import { z } from 'zod';

const putawayLineInputSchema = z.object({
  purchaseOrderReceiptLineId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantity: z.number().positive(),
  lineNumber: z.number().int().positive().optional(),
  fromLocationId: z.string().uuid().optional(),
  notes: z.string().max(1000).optional()
});

export const putawaySchema = z
  .object({
    sourceType: z.enum(['purchase_order_receipt', 'qc', 'manual']),
    purchaseOrderReceiptId: z.string().uuid().optional(),
    notes: z.string().max(2000).optional(),
    lines: z.array(putawayLineInputSchema).min(1)
  })
  .superRefine((data, ctx) => {
    if (data.sourceType === 'purchase_order_receipt' && !data.purchaseOrderReceiptId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'purchaseOrderReceiptId is required when sourceType is purchase_order_receipt',
        path: ['purchaseOrderReceiptId']
      });
    }
  });
