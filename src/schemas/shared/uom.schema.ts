import { z } from 'zod';

export const uomSchema = z
  .string()
  .trim()
  .min(1, 'UOM_REQUIRED');
