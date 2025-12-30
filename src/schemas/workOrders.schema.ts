import { z } from 'zod';

export const workOrderCreateSchema = z
  .object({
    workOrderNumber: z.string().min(1).max(255),
    kind: z.enum(['production', 'disassembly']).default('production'),
    bomId: z.string().uuid().optional(),
    bomVersionId: z.string().uuid().optional(),
    outputItemId: z.string().uuid(),
    outputUom: z.string().min(1).max(32),
    quantityPlanned: z.number().positive(),
    quantityCompleted: z.number().min(0).optional(),
    defaultConsumeLocationId: z.string().uuid().optional(),
    defaultProduceLocationId: z.string().uuid().optional(),
    scheduledStartAt: z.string().datetime().optional(),
    scheduledDueAt: z.string().datetime().optional(),
    notes: z.string().max(2000).optional(),
    relatedWorkOrderId: z.string().uuid().optional()
  })
  .superRefine((data, ctx) => {
    if (data.kind === 'production' && !data.bomId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bomId is required for production work orders.',
        path: ['bomId']
      });
    }
    if (data.kind === 'disassembly' && !data.notes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'notes are required for disassembly work orders.',
        path: ['notes']
      });
    }
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
  kind: z.enum(['production', 'disassembly']).optional(),
  plannedFrom: z.string().datetime().optional(),
  plannedTo: z.string().datetime().optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
});

export const workOrderRequirementsQuerySchema = z.object({
  quantity: z.string().optional(),
  packSize: z.string().optional()
});

export const workOrderDefaultLocationsSchema = z.object({
  defaultConsumeLocationId: z.string().uuid().nullable().optional(),
  defaultProduceLocationId: z.string().uuid().nullable().optional()
});
