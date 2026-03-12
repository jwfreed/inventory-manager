import { z } from 'zod';

export const vendorSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(32).optional(),
  contactName: z.string().max(255).optional(),
  addressLine1: z.string().max(255).optional(),
  addressLine2: z.string().max(255).optional(),
  city: z.string().max(255).optional(),
  state: z.string().max(255).optional(),
  postalCode: z.string().max(32).optional(),
  country: z.string().max(64).optional(),
  notes: z.string().max(2000).optional(),
});

export const vendorUpdateSchema = vendorSchema.extend({
  active: z.boolean().optional()
});
