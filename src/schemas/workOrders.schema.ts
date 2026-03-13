import { z } from 'zod';
import { uomSchema } from './shared/uom.schema';
import { isSupportedDateInput, normalizeDateInputToIso } from '../core/dateAdapter';

const workOrderStatusSchema = z.enum([
  'draft',
  'ready',
  'released',
  'in_progress',
  'partially_completed',
  'completed',
  'closed',
  'canceled'
]);

const workOrderDateSchema = z.string().trim().min(1).refine((value) => isSupportedDateInput(value), {
  message: 'Date must be ISO or DD-MM-YY.'
}).transform((value) => normalizeDateInputToIso(value)!);

export const workOrderCreateSchema = z
  .object({
    kind: z.enum(['production', 'disassembly']).default('production'),
    bomId: z.string().uuid().optional(),
    bomVersionId: z.string().uuid().optional(),
    outputItemId: z.string().uuid(),
    outputUom: uomSchema.max(32),
    quantityPlanned: z.number().positive(),
    quantityCompleted: z.number().min(0).optional(),
    defaultConsumeLocationId: z.string().uuid().optional(),
    defaultProduceLocationId: z.string().uuid().optional(),
    scheduledStartAt: workOrderDateSchema.optional(),
    scheduledDueAt: workOrderDateSchema.optional(),
    description: z.string().max(2000).optional(),
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
    if (data.scheduledStartAt && data.scheduledDueAt) {
      const start = new Date(data.scheduledStartAt);
      const due = new Date(data.scheduledDueAt);
      if (!(start instanceof Date && !Number.isNaN(start.valueOf()) && due instanceof Date && !Number.isNaN(due.valueOf()))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'scheduledStartAt and scheduledDueAt must be valid dates.',
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
  status: workOrderStatusSchema.optional(),
  kind: z.enum(['production', 'disassembly']).optional(),
  plannedFrom: workOrderDateSchema.optional(),
  plannedTo: workOrderDateSchema.optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
});

export const workOrderRequirementsQuerySchema = z.object({
  quantity: z.string().optional(),
  packSize: z.string().optional()
});

export const workOrderUpdateSchema = z.object({
  description: z.string().max(2000).optional()
});
