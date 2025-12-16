import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const lotSchema = z.object({
  itemId: z.string().uuid(),
  lotCode: z.string().min(1),
  status: z.enum(['active', 'quarantine', 'blocked', 'consumed', 'expired']).optional(),
  manufacturedAt: z.string().optional(),
  receivedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  vendorLotCode: z.string().optional(),
  notes: z.string().optional(),
});

export const movementLotAllocationsSchema = z.object({
  allocations: z
    .array(
      z.object({
        lotId: z.string().uuid(),
        uom: z.string().min(1),
        quantityDelta: z.string(),
      }),
    )
    .min(1),
});

export const recallCaseSchema = z.object({
  recallNumber: z.string().min(1),
  status: z.enum(['draft', 'active', 'closed', 'canceled']).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  initiatedAt: z.string().optional(),
  closedAt: z.string().optional(),
  summary: z.string().optional(),
  notes: z.string().optional(),
});

export const recallCaseStatusPatchSchema = z.object({
  status: z.enum(['draft', 'active', 'closed', 'canceled']),
});

export const recallCaseTargetSchema = z.object({
  targets: z
    .array(
      z.object({
        targetType: z.enum(['lot', 'item']),
        lotId: z.string().uuid().optional(),
        itemId: z.string().uuid().optional(),
        uom: z.string().optional(),
      }),
    )
    .min(1),
});

export const recallTraceRunSchema = z.object({
  asOf: z.string(),
  status: z.enum(['computed', 'superseded']).optional(),
  notes: z.string().optional(),
});

export const recallImpactedShipmentSchema = z.object({
  shipments: z
    .array(
      z.object({
        salesOrderShipmentId: z.string().uuid(),
        customerId: z.string().uuid(),
      }),
    )
    .min(1),
});

export const recallImpactedLotSchema = z.object({
  lots: z
    .array(
      z.object({
        lotId: z.string().uuid(),
        role: z.enum(['target', 'upstream_component', 'downstream_finished']),
      }),
    )
    .min(1),
});

export const recallActionSchema = z.object({
  actions: z
    .array(
      z.object({
        actionType: z.enum(['block_lot', 'quarantine_lot', 'scrap_lot', 'restock_lot', 'customer_notify']),
        status: z.enum(['planned', 'in_progress', 'completed', 'canceled']).optional(),
        lotId: z.string().uuid().optional(),
        salesOrderShipmentId: z.string().uuid().optional(),
        inventoryMovementId: z.string().uuid().optional(),
        notes: z.string().optional(),
      }),
    )
    .min(1),
});

export const recallCommunicationSchema = z.object({
  communications: z
    .array(
      z.object({
        customerId: z.string().uuid().optional(),
        channel: z.enum(['email', 'phone', 'letter', 'portal']),
        status: z.enum(['draft', 'sent', 'failed']).optional(),
        sentAt: z.string().optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        externalRef: z.string().optional(),
      }),
    )
    .min(1),
});
