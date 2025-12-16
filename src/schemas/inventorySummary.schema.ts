import { z } from 'zod';

export const inventorySummaryParamsSchema = z.object({
  id: z.string().uuid()
});
