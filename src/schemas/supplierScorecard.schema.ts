import { z } from 'zod';

const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const supplierScorecardQuerySchema = z.object({
  vendorId: z.string().uuid().optional(),
  startDate: isoDateString.optional(),
  endDate: isoDateString.optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

export const supplierScorecardDetailQuerySchema = z.object({
  vendorId: z.string().uuid(),
  startDate: isoDateString.optional(),
  endDate: isoDateString.optional()
});

export const topSuppliersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

export const qualityIssuesQuerySchema = z.object({
  minRejectionRate: z.coerce.number().min(0).max(100).optional()
});
