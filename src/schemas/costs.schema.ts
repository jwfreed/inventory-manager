import { z } from 'zod';

export const componentCostSnapshotSchema = z.object({
  componentItemId: z.string().uuid(),
  componentSku: z.string(),
  componentName: z.string(),
  quantityPer: z.number().positive(),
  uom: z.string(),
  unitCost: z.number().nonnegative(),
  extendedCost: z.number().nonnegative(),
  scrapFactor: z.number().nonnegative().optional()
});

export const createItemCostHistorySchema = z.object({
  itemId: z.string().uuid(),
  costType: z.enum(['standard', 'rolled', 'avg']),
  oldValue: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative().nullable()),
  newValue: z.preprocess((val) => {
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative()),
  calculatedBy: z.string().uuid().nullable().optional(),
  bomVersionId: z.string().uuid().nullable().optional(),
  componentSnapshot: z.array(componentCostSnapshotSchema).nullable().optional()
});
