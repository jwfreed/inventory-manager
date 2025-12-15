import { z } from 'zod';

export const bomComponentInputSchema = z.object({
  lineNumber: z.number().int().positive(),
  componentItemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityPer: z.number().positive(),
  scrapFactor: z.number().min(0).optional(),
  notes: z.string().max(2000).optional()
});

export const bomVersionInputSchema = z
  .object({
    versionNumber: z.number().int().positive().optional(),
    effectiveFrom: z.string().datetime().optional(),
    effectiveTo: z.string().datetime().optional(),
    yieldQuantity: z.number().positive(),
    yieldUom: z.string().min(1).max(32),
    notes: z.string().max(2000).optional(),
    components: z.array(bomComponentInputSchema).min(1)
  })
  .superRefine((data, ctx) => {
    if (data.effectiveFrom && data.effectiveTo) {
      const from = new Date(data.effectiveFrom);
      const to = new Date(data.effectiveTo);
      if (!(from instanceof Date && !Number.isNaN(from.valueOf()) && to instanceof Date && !Number.isNaN(to.valueOf()))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectiveFrom and effectiveTo must be valid ISO datetimes.',
          path: ['effectiveFrom']
        });
        return;
      }
      if (to <= from) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectiveTo must be after effectiveFrom.',
          path: ['effectiveTo']
        });
      }
    }
  });

export const bomCreateSchema = z.object({
  bomCode: z.string().min(1).max(64),
  outputItemId: z.string().uuid(),
  defaultUom: z.string().min(1).max(32),
  notes: z.string().max(2000).optional(),
  version: bomVersionInputSchema
});

export const bomActivationSchema = z
  .object({
    effectiveFrom: z.string().datetime(),
    effectiveTo: z.string().datetime().optional()
  })
  .superRefine((data, ctx) => {
    if (data.effectiveTo) {
      const from = new Date(data.effectiveFrom);
      const to = new Date(data.effectiveTo);
      if (!(from instanceof Date && !Number.isNaN(from.valueOf()) && to instanceof Date && !Number.isNaN(to.valueOf()))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectiveFrom and effectiveTo must be valid ISO datetimes.',
          path: ['effectiveFrom']
        });
        return;
      }
      if (to <= from) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectiveTo must be after effectiveFrom.',
          path: ['effectiveTo']
        });
      }
    }
  });
