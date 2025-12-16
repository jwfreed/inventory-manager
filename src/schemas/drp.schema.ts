import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const drpNodeSchema = z.object({
  code: z.string().min(1),
  locationId: z.string().uuid(),
  nodeType: z.enum(['plant', 'dc', 'store']),
  active: z.boolean().optional(),
});

export const drpLaneSchema = z.object({
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
  transferLeadTimeDays: z.number().int().nonnegative(),
  active: z.boolean().optional(),
  notes: z.string().optional(),
});

export const drpRunSchema = z.object({
  status: z.enum(['draft', 'computed', 'published', 'archived']).optional(),
  bucketType: z.enum(['day', 'week', 'month']),
  startsOn: isoDate,
  endsOn: isoDate,
  asOf: z.string(),
  notes: z.string().optional(),
});

export const drpPeriodsCreateSchema = z.object({
  periods: z
    .array(
      z.object({
        periodStart: isoDate,
        periodEnd: isoDate,
        sequence: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

export const drpItemPoliciesCreateSchema = z.object({
  policies: z
    .array(
      z.object({
        toNodeId: z.string().uuid(),
        preferredFromNodeId: z.string().uuid().optional(),
        itemId: z.string().uuid(),
        uom: z.string().min(1),
        safetyStockQty: z.string().optional(),
        lotSizingMethod: z.enum(['l4l', 'foq']),
        foqQty: z.string().optional(),
      }),
    )
    .min(1),
});

export const drpGrossRequirementsCreateSchema = z.object({
  requirements: z
    .array(
      z.object({
        toNodeId: z.string().uuid(),
        itemId: z.string().uuid(),
        uom: z.string().min(1),
        periodStart: isoDate,
        sourceType: z.enum(['forecast', 'sales_orders', 'dependent']),
        sourceRef: z.string().optional(),
        quantity: z.string(),
      }),
    )
    .min(1),
});
