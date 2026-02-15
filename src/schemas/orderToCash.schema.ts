import { z } from 'zod';

const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD');

const isoDateTimeString = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
    'Use ISO timestamp',
  );

const uuid = () => z.string().uuid();

export const salesOrderLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  itemId: uuid(),
  uom: z.string().min(1).max(32),
  quantityOrdered: z.number().positive(),
  unitPrice: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative().nullable().optional()),
  currencyCode: z.string().length(3).toUpperCase().nullable().optional(),
  exchangeRateToBase: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().positive().nullable().optional()),
  lineAmount: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative().nullable().optional()),
  baseAmount: z.preprocess((val) => {
    if (val === null || val === undefined) return null;
    const num = typeof val === 'string' ? Number(val) : val;
    return num;
  }, z.number().nonnegative().nullable().optional()),
  notes: z.string().max(1000).optional(),
});

export const salesOrderSchema = z.object({
  soNumber: z.string().min(1).max(64),
  customerId: uuid(),
  status: z
    .enum(['draft', 'submitted', 'partially_shipped', 'shipped', 'closed', 'canceled'])
    .optional(),
  orderDate: isoDateString.optional(),
  requestedShipDate: isoDateString.optional(),
  shipFromLocationId: uuid().optional(),
  customerReference: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(salesOrderLineSchema).min(1),
});

export const reservationSchema = z.object({
  demandType: z.literal('sales_order_line'),
  demandId: uuid(),
  itemId: uuid(),
  locationId: uuid(),
  warehouseId: uuid(),
  uom: z.string().min(1).max(32),
  quantityReserved: z.number().positive(),
  quantityFulfilled: z.number().nonnegative().optional(),
  expiresAt: isoDateTimeString.optional(),
  allowBackorder: z.boolean().optional(),
  status: z.enum(['RESERVED', 'ALLOCATED', 'FULFILLED', 'CANCELLED', 'EXPIRED']).optional(),
  notes: z.string().max(1000).optional(),
});

export const reservationsCreateSchema = z.object({
  reservations: z.array(reservationSchema).min(1),
});

export const shipmentLineSchema = z.object({
  salesOrderLineId: uuid(),
  uom: z.string().min(1).max(32),
  quantityShipped: z.number().positive(),
});

export const shipmentSchema = z.object({
  salesOrderId: uuid(),
  shippedAt: isoDateTimeString,
  shipFromLocationId: uuid().optional(),
  externalRef: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(shipmentLineSchema).min(1),
});

export const returnLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  salesOrderLineId: uuid().optional(),
  itemId: uuid(),
  uom: z.string().min(1).max(32),
  quantityAuthorized: z.number().positive(),
  reasonCode: z.string().max(255).optional(),
  notes: z.string().max(1000).optional(),
});

export const returnAuthorizationSchema = z.object({
  rmaNumber: z.string().min(1).max(64),
  customerId: uuid(),
  salesOrderId: uuid().optional(),
  status: z.enum(['draft', 'authorized', 'closed', 'canceled']).optional(),
  severity: z.string().max(64).optional(),
  authorizedAt: isoDateTimeString.optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(returnLineSchema).min(1),
});
