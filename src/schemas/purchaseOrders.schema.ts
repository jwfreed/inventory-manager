import { z } from 'zod';

const toDateString = (val: unknown) => {
  if (typeof val === 'string') {
    const parsed = new Date(val);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return val;
};

const isoDateString = z
  .string()
  .transform((val) => val.trim())
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD'));

export const purchaseOrderLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  itemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityOrdered: z.preprocess((val) => {
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().positive()),
  notes: z.string().max(1000).optional()
});

export const purchaseOrderSchema = z.object({
  poNumber: z.string().min(1).max(64).optional(),
  vendorId: z.string().uuid(),
  status: z.enum(['draft', 'submitted']).optional(),
  orderDate: z.preprocess(toDateString, isoDateString).optional(),
  expectedDate: z.preprocess(toDateString, isoDateString).optional(),
  shipToLocationId: z.string().uuid().optional(),
  receivingLocationId: z.string().uuid().optional(),
  vendorReference: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(purchaseOrderLineSchema).min(1)
});

export const purchaseOrderUpdateSchema = purchaseOrderSchema
  .omit({ vendorId: true })
  .extend({
    vendorId: z.string().uuid().optional(),
    lines: z.array(purchaseOrderLineSchema).optional()
  });
