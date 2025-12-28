import { z } from 'zod';

export const auditListQuerySchema = z.object({
  entityType: z.string().min(1).max(128),
  entityId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional()
});
