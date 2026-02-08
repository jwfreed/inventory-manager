import { z } from 'zod';
import { ItemLifecycleStatus } from '../types/item';

const uomDimensionSchema = z.enum(['mass', 'volume', 'count', 'length', 'area', 'time']);
const canonicalUomByDimension: Record<z.infer<typeof uomDimensionSchema>, string> = {
  mass: 'g',
  volume: 'L',
  count: 'each',
  length: 'm',
  area: 'm2',
  time: 'seconds',
};

export const itemSchema = z.object({
  sku: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  lifecycleStatus: z.nativeEnum(ItemLifecycleStatus).default(ItemLifecycleStatus.ACTIVE),
  type: z.enum(['raw', 'wip', 'finished', 'packaging']).default('raw'),
  isPhantom: z.boolean().default(false),
  defaultUom: z.string().min(1).max(50).nullable().optional(),
  uomDimension: uomDimensionSchema.nullable().optional(),
  canonicalUom: z.string().min(1).max(32).nullable().optional(),
  stockingUom: z.string().min(1).max(50).nullable().optional(),
  defaultLocationId: z.string().uuid().nullable().optional(),
  requiresLot: z.boolean().optional(),
  requiresSerial: z.boolean().optional(),
  requiresQc: z.boolean().optional(),
  weight: z.number().positive().nullable().optional(),
  weightUom: z.string().max(50).nullable().optional(),
  volume: z.number().positive().nullable().optional(),
  volumeUom: z.string().max(50).nullable().optional(),
  standardCost: z.preprocess((val) => {
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative().nullable().optional()),
  standardCostCurrency: z.string().length(3).toUpperCase().nullable().optional(),
  rolledCost: z.preprocess((val) => {
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative().nullable().optional()),
  costMethod: z.enum(['standard', 'rolled', 'avg']).nullable().optional(),
  sellingPrice: z.preprocess((val) => {
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative().nullable().optional()),
  listPrice: z.preprocess((val) => {
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative().nullable().optional()),
  priceCurrency: z.string().length(3).nullable().optional(),
}).superRefine((data, ctx) => {
  const hasAny =
    data.uomDimension !== undefined ||
    data.canonicalUom !== undefined ||
    data.stockingUom !== undefined;
  if (!hasAny) return;
  if (!data.uomDimension || !data.canonicalUom || !data.stockingUom) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'uomDimension, canonicalUom, and stockingUom must be provided together.',
      path: ['uomDimension'],
    });
    return;
  }
  const expected = canonicalUomByDimension[data.uomDimension];
  if (data.canonicalUom !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `canonicalUom must be ${expected} for ${data.uomDimension}.`,
      path: ['canonicalUom'],
    });
  }
});

export const locationSchema = z.object({
  code: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  type: z.enum(['warehouse', 'bin', 'store', 'customer', 'vendor', 'scrap', 'virtual']),
  role: z.enum(['SELLABLE', 'QA', 'HOLD', 'REJECT', 'SCRAP']).nullable().optional(),
  isSellable: z.boolean().optional(),
  active: z.boolean().optional(),
  parentLocationId: z.string().uuid().nullable().optional(),
  maxWeight: z.number().positive().nullable().optional(),
  maxVolume: z.number().positive().nullable().optional(),
  zone: z.string().max(255).nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.type === 'warehouse') {
    if (data.role != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Warehouse roots cannot have a role.',
        path: ['role']
      });
    }
    if (data.isSellable === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Warehouse roots cannot be sellable.',
        path: ['isSellable']
      });
    }
    if (data.parentLocationId != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Warehouse roots cannot have a parent.',
        path: ['parentLocationId']
      });
    }
    return;
  }
  if (data.role === 'SELLABLE' && data.isSellable === false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Location role must match sellable flag.',
      path: ['isSellable']
    });
  }
  if (data.role && data.role !== 'SELLABLE' && data.isSellable === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Location role must match sellable flag.',
      path: ['isSellable']
    });
  }
  if (data.role == null && data.isSellable === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Location role must match sellable flag.',
      path: ['isSellable']
    });
  }
});

export const uomConversionSchema = z.object({
  itemId: z.string().uuid(),
  fromUom: z.string().min(1).max(50),
  toUom: z.string().min(1).max(50),
  factor: z.number().positive(),
});
