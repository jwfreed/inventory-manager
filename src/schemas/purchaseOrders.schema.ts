import { z } from 'zod';

const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD');

export const purchaseOrderLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  itemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityOrdered: z.number().positive(),
  notes: z.string().max(1000).optional()
});

export const purchaseOrderSchema = z.object({
  poNumber: z.string().min(1).max(64),
  vendorId: z.string().uuid(),
  status: z.enum(['draft', 'submitted']).optional(),
  orderDate: isoDateString.optional(),
  expectedDate: isoDateString.optional(),
  shipToLocationId: z.string().uuid().optional(),
  vendorReference: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(purchaseOrderLineSchema).min(1)
});
