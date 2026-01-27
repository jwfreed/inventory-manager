import { z } from 'zod';

const toSingleString = (val: unknown) => {
  if (Array.isArray(val)) return val[0];
  if (val === undefined || val === null) return val;
  if (typeof val === 'object') return String(val as unknown);
  return String(val);
};

export const inventoryChangesQuerySchema = z.object({
  since: z.preprocess(toSingleString, z.string().regex(/^\d+$/)).optional(),
  limit: z.preprocess((val) => Number(toSingleString(val)), z.number().int().positive().max(500)).optional()
});

export type InventoryChangesQuery = z.infer<typeof inventoryChangesQuerySchema>;
