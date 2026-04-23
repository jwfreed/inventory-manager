import { z } from 'zod';
import { uomSchema } from './shared/uom.schema';

const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD');

export const mpsPlanSchema = z.object({
  code: z.string().min(1).max(64),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  bucketType: z.enum(['day', 'week', 'month']),
  startsOn: isoDateString,
  endsOn: isoDateString,
  notes: z.string().max(4000).optional()
});

export const mpsPeriodSchema = z.object({
  periodStart: isoDateString,
  periodEnd: isoDateString,
  sequence: z.number().int().positive()
});

export const mpsPeriodsCreateSchema = z.object({
  periods: z.array(mpsPeriodSchema).min(1)
});

export const mpsDemandInputSchema = z.object({
  mpsPlanItemId: z.string().uuid(),
  mpsPeriodId: z.string().uuid(),
  demandType: z.enum(['forecast', 'sales_orders']),
  quantity: z.number().nonnegative()
});

export const mpsDemandInputsCreateSchema = z.object({
  inputs: z.array(mpsDemandInputSchema).min(1)
});

export const mrpRunSchema = z.object({
  mpsPlanId: z.string().uuid(),
  status: z.enum(['draft', 'computed', 'published', 'archived']).optional(),
  asOf: z.string(),
  bucketType: z.enum(['day', 'week', 'month']),
  startsOn: isoDateString,
  endsOn: isoDateString,
  notes: z.string().max(4000).optional()
});

export const mrpItemPolicySchema = z.object({
  itemId: z.string().uuid(),
  uom: uomSchema.max(32),
  siteLocationId: z.string().uuid().nullable().optional(),
  planningLeadTimeDays: z.number().int().nonnegative().optional(),
  safetyStockQty: z.number().nonnegative().optional(),
  lotSizingMethod: z.enum(['l4l', 'foq', 'poq', 'ppb']),
  foqQty: z.number().positive().optional(),
  poqPeriods: z.number().int().positive().optional(),
  ppbPeriods: z.number().int().positive().optional()
});

export const mrpItemPoliciesCreateSchema = z.object({
  policies: z.array(mrpItemPolicySchema).min(1)
});

export const mrpGrossRequirementSchema = z.object({
  itemId: z.string().uuid(),
  uom: uomSchema.max(32),
  siteLocationId: z.string().uuid().nullable().optional(),
  periodStart: isoDateString,
  sourceType: z.enum(['mps', 'bom_explosion', 'sales_orders']),
  sourceRef: z.string().max(255).optional(),
  quantity: z.number().nonnegative()
});

export const mrpGrossRequirementsCreateSchema = z.object({
  requirements: z.array(mrpGrossRequirementSchema).min(1)
});

export const replenishmentPolicySchema = z
  .object({
    itemId: z.string().uuid(),
    uom: uomSchema.max(32),
    siteLocationId: z.string().uuid().nullable().optional(),
    policyType: z.enum(['q_rop', 't_oul', 'min_max']),
    status: z.enum(['active', 'inactive']).optional(),
    leadTimeDays: z.number().int().nonnegative().optional(),
    demandRatePerDay: z.number().nonnegative().optional(),
    safetyStockMethod: z.enum(['none', 'fixed', 'ppis']),
    safetyStockQty: z.number().nonnegative().optional(),
    ppisPeriods: z.number().int().positive().optional(),
    reviewPeriodDays: z.number().int().positive().optional(),
    orderUpToLevelQty: z.number().nonnegative().optional(),
    reorderPointQty: z.number().nonnegative().optional(),
    orderQuantityQty: z.number().positive().optional(),
    minOrderQty: z.number().nonnegative().optional(),
    maxOrderQty: z.number().nonnegative().optional(),
    notes: z.string().max(4000).optional()
  })
  .superRefine((value, ctx) => {
    const hasExplicitReorderPoint = value.reorderPointQty !== undefined && value.reorderPointQty !== null;
    const hasDerivedReorderPointInputs = value.leadTimeDays !== undefined && value.demandRatePerDay !== undefined;

    if (!hasExplicitReorderPoint && !hasDerivedReorderPointInputs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reorderPointQty'],
        message: 'Provide reorderPointQty or both leadTimeDays and demandRatePerDay.'
      });
    }

    if (value.policyType === 'q_rop' && value.orderQuantityQty === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orderQuantityQty'],
        message: 'Q/ROP requires orderQuantityQty.'
      });
    }

    if ((value.policyType === 't_oul' || value.policyType === 'min_max') && value.orderUpToLevelQty === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orderUpToLevelQty'],
        message: 'Min-Max requires orderUpToLevelQty.'
      });
    }

    if (
      (value.policyType === 't_oul' || value.policyType === 'min_max') &&
      value.orderUpToLevelQty !== undefined &&
      value.reorderPointQty !== undefined &&
      value.orderUpToLevelQty < value.reorderPointQty
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orderUpToLevelQty'],
        message: 'orderUpToLevelQty must be greater than or equal to reorderPointQty.'
      });
    }

    if (value.safetyStockMethod === 'fixed' && value.safetyStockQty === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['safetyStockQty'],
        message: 'Fixed safety stock requires safetyStockQty.'
      });
    }

    if (value.safetyStockMethod === 'ppis') {
      if (value.ppisPeriods === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ppisPeriods'],
          message: 'PPIS cycle coverage requires ppisPeriods.'
        });
      }
      if (value.demandRatePerDay === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['demandRatePerDay'],
          message: 'PPIS cycle coverage requires demandRatePerDay.'
        });
      }
    }

    if (
      value.minOrderQty !== undefined &&
      value.maxOrderQty !== undefined &&
      value.maxOrderQty < value.minOrderQty
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxOrderQty'],
        message: 'maxOrderQty must be greater than or equal to minOrderQty.'
      });
    }
  });

export const kpiRunSchema = z.object({
  status: z.enum(['draft', 'computed', 'published', 'archived']).optional(),
  windowStart: z.string().optional(),
  windowEnd: z.string().optional(),
  asOf: z.string().optional(),
  notes: z.string().max(4000).optional()
});

export const kpiSnapshotSchema = z.object({
  kpiName: z.string().min(1).max(255),
  dimensions: z.record(z.unknown()),
  value: z.number().nullable().optional(),
  units: z.string().max(64).optional()
});

export const kpiSnapshotsCreateSchema = z.object({
  snapshots: z.array(kpiSnapshotSchema).min(1)
});

export const kpiRollupInputSchema = z.object({
  metricName: z.string().min(1).max(255),
  dimensions: z.record(z.unknown()),
  numeratorQty: z.number().nullable().optional(),
  denominatorQty: z.number().nullable().optional()
});

export const kpiRollupInputsCreateSchema = z.object({
  inputs: z.array(kpiRollupInputSchema).min(1)
});

const isoDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
    'Use ISO timestamp'
  );

export const fulfillmentFillRateQuerySchema = z.object({
  from: isoDateTime.optional(),
  to: isoDateTime.optional()
});

export type FulfillmentFillRateQuery = z.infer<typeof fulfillmentFillRateQuerySchema>;
