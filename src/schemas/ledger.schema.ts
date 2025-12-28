import { z } from 'zod';

export const movementListQuerySchema = z.object({
  movement_type: z.string().optional(),
  status: z.string().optional(),
  external_ref: z.string().optional(),
  occurred_from: z.string().optional(),
  occurred_to: z.string().optional(),
  item_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional()
});
