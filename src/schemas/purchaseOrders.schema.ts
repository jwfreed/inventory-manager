import { z } from 'zod';

const toDateString = (val: unknown) => {
  if (val instanceof Date) {
    if (!Number.isNaN(val.getTime())) {
      return val.toISOString().slice(0, 10);
    }
    return val;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();

    // If the caller already sent a date-only string, preserve it as-is (avoid timezone shifts).
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }

    // If the caller sent an ISO timestamp, take the date portion.
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }

    // Support common dev input like "MM/DD/YYYY" without involving timezone conversion.
    const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
    if (mdy) {
      const month = mdy[1].padStart(2, '0');
      const day = mdy[2].padStart(2, '0');
      const year = mdy[3];
      return `${year}-${month}-${day}`;
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
  unitCost: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative().nullable().optional()),
  unitPrice: z.preprocess((val) => {
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative().nullable().optional()),
  currencyCode: z.string().length(3).toUpperCase().nullable().optional(),
  exchangeRateToBase: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().positive().nullable().optional()),
  lineAmount: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative().nullable().optional()),
  baseAmount: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative().nullable().optional()),
  overReceiptTolerancePct: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().min(0).max(1).nullable().optional()),
  notes: z.string().max(1000).optional()
});

export const purchaseOrderSchema = z.object({
  poNumber: z.string().min(1).max(64).optional(),
  vendorId: z.string().uuid(),
  status: z.enum(['draft', 'submitted', 'approved', 'partially_received', 'received', 'closed', 'canceled']).optional(),
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
