import { z } from 'zod';

export const returnReceiptSchema = z.object({
  returnAuthorizationId: z.string().uuid(),
  status: z.enum(['draft', 'posted', 'canceled']).optional(),
  receivedAt: z.string(),
  receivedToLocationId: z.string().uuid(),
  inventoryMovementId: z.string().uuid().nullable().optional(),
  externalRef: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  lines: z
    .array(
      z.object({
        returnAuthorizationLineId: z.string().uuid().optional(),
        itemId: z.string().uuid(),
        uom: z.string().min(1).max(32),
        quantityReceived: z.number().positive(),
        notes: z.string().max(2000).optional(),
      }),
    )
    .optional(),
});

export const returnReceiptLineSchema = z.object({
  returnAuthorizationLineId: z.string().uuid().optional(),
  itemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantityReceived: z.number().positive(),
  notes: z.string().max(2000).optional(),
});

export const returnDispositionSchema = z.object({
  returnReceiptId: z.string().uuid(),
  status: z.enum(['draft', 'posted', 'canceled']).optional(),
  occurredAt: z.string(),
  dispositionType: z.enum(['restock', 'scrap', 'quarantine_hold']),
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid().nullable().optional(),
  inventoryMovementId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).optional(),
  lines: z
    .array(
      z.object({
        lineNumber: z.number().int().positive().optional(),
        itemId: z.string().uuid(),
        uom: z.string().min(1).max(32),
        quantity: z.number().positive(),
        notes: z.string().max(2000).optional(),
      }),
    )
    .optional(),
});

export const returnDispositionLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  itemId: z.string().uuid(),
  uom: z.string().min(1).max(32),
  quantity: z.number().positive(),
  notes: z.string().max(2000).optional(),
});
