import { z } from 'zod';

export const workOrderCreateSchema = z
  .object({
    workOrderNumber: z.string().min(1).max(255),
    bomId: z.string().uuid(),
    bomVersionId: z.string().uuid().optional(),
    outputItemId: z.string().uuid(),
    outputUom: z.string().min(1).max(32),
    quantityPlanned: z.number().positive(),
    quantityCompleted: z.number().min(0).optional(),
    scheduledStartAt: z.string().datetime().optional(),
    scheduledDueAt: z.string().datetime().optional(),
    notes: z.string().max(2000).optional()
  })
  .superRefine((data, ctx) => {
    if (data.scheduledStartAt && data.scheduledDueAt) {
      const start = new Date(data.scheduledStartAt);
      const due = new Date(data.scheduledDueAt);
      if (!(start instanceof Date && !Number.isNaN(start.valueOf()) && due instanceof Date && !Number.isNaN(due.valueOf()))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'scheduledStartAt and scheduledDueAt must be valid ISO datetimes.',
          path: ['scheduledStartAt']
        });
        return;
      }
      if (due < start) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'scheduledDueAt must be after scheduledStartAt.',
          path: ['scheduledDueAt']
        });
      }
    }
  });

export const workOrderListQuerySchema = z.object({
  status: z.enum(['draft', 'released', 'in_progress', 'completed', 'canceled']).optional(),
  plannedFrom: z.string().datetime().optional(),
  plannedTo: z.string().datetime().optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
});

export const workOrderRequirementsQuerySchema = z.object({
  quantity: z.string().optional()
});
