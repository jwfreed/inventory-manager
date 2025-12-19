import { z } from 'zod';

const toSingleString = (val: unknown) => {
  if (Array.isArray(val)) return val[0];
  if (val === undefined || val === null) return val;
  if (typeof val === 'object') return String(val as unknown);
  return String(val);
};

const toUuidString = (val: unknown) => {
  const str = toSingleString(val);
  return typeof str === 'string' ? str.toLowerCase() : str;
};

export const inventorySnapshotQuerySchema = z.object({
  itemId: z.preprocess(toUuidString, z.string().uuid()),
  locationId: z.preprocess(toUuidString, z.string().uuid()),
  uom: z.preprocess(toSingleString, z.string().min(1).max(32)).optional()
});

export type InventorySnapshotQuery = z.infer<typeof inventorySnapshotQuerySchema>;

export const inventorySnapshotSummaryQuerySchema = z.object({
  itemId: z.preprocess(toUuidString, z.string().uuid()).optional(),
  locationId: z.preprocess(toUuidString, z.string().uuid()).optional(),
  limit: z.preprocess((val) => Number(toSingleString(val)), z.number().int().positive().max(2000)).optional(),
  offset: z.preprocess((val) => Number(toSingleString(val)), z.number().int().min(0)).optional()
});

export type InventorySnapshotSummaryQuery = z.infer<typeof inventorySnapshotSummaryQuerySchema>;
