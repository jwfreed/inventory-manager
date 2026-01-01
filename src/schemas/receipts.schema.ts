import { z } from 'zod';

const receiptLineSchema = z.object({
  purchaseOrderLineId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityReceived: z.number().positive(),
  unitCost: z.preprocess(
    (val) => (typeof val === 'string' ? Number(val) : val),
    z.number().nonnegative().nullable().optional()
  ),
  discrepancyReason: z.enum(['short', 'over', 'damaged', 'substituted']).optional(),
  discrepancyNotes: z.string().max(2000).optional()
});

export const purchaseOrderReceiptSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  receivedAt: z.string().datetime(),
  receivedToLocationId: z.string().uuid().optional(),
  externalRef: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(receiptLineSchema).min(1)
});
