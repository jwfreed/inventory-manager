import { z } from 'zod';

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
  uom: z.string().min(1).max(32),
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
  uom: z.string().min(1).max(32),
  siteLocationId: z.string().uuid().nullable().optional(),
  periodStart: isoDateString,
  sourceType: z.enum(['mps', 'bom_explosion']),
  sourceRef: z.string().max(255).optional(),
  quantity: z.number().nonnegative()
});

export const mrpGrossRequirementsCreateSchema = z.object({
  requirements: z.array(mrpGrossRequirementSchema).min(1)
});

export const replenishmentPolicySchema = z.object({
  itemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  siteLocationId: z.string().uuid().nullable().optional(),
  policyType: z.enum(['q_rop', 't_oul']),
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
