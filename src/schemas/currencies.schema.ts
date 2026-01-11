import { z } from 'zod';

export const createExchangeRateSchema = z.object({
  fromCurrency: z.string().length(3).toUpperCase(),
  toCurrency: z.string().length(3).toUpperCase(),
  rate: z.preprocess((val) => {
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().positive()),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().max(255).nullable().optional()
}).refine(
  (data) => data.fromCurrency !== data.toCurrency,
  { message: 'From and to currencies must be different' }
);

export const currencySchema = z.object({
  code: z.string().length(3).toUpperCase(),
  name: z.string().min(1).max(255),
  symbol: z.string().min(1).max(10),
  decimalPlaces: z.number().int().min(0).max(4).default(2),
  active: z.boolean().default(true)
});
