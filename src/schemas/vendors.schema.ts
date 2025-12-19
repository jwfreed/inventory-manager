import { z } from 'zod';

export const vendorSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(32).optional()
});

export const vendorUpdateSchema = vendorSchema.extend({
  active: z.boolean().optional()
});
