import { z } from 'zod';

export const workOrderIssueLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  componentItemId: z.string().uuid(),
  fromLocationId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityIssued: z.number().positive(),
  notes: z.string().max(2000).optional()
});

export const workOrderIssueCreateSchema = z.object({
  occurredAt: z.string().datetime(),
  notes: z.string().max(2000).optional(),
  lines: z.array(workOrderIssueLineSchema).min(1)
});

export const workOrderCompletionLineSchema = z.object({
  outputItemId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityCompleted: z.number().positive(),
  notes: z.string().max(2000).optional()
});

export const workOrderCompletionCreateSchema = z.object({
  occurredAt: z.string().datetime(),
  notes: z.string().max(2000).optional(),
  lines: z.array(workOrderCompletionLineSchema).min(1)
});
