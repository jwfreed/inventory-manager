import { z } from 'zod';
import { uomSchema } from './shared/uom.schema';
import { normalizeDateInputToIso } from '../core/dateAdapter';

const workOrderExecutionDateSchema = z.string().trim().transform((value, ctx) => {
  const normalized = normalizeDateInputToIso(value) ?? value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid date. Expected DD-MM-YY or ISO timestamp.'
    });
    return z.NEVER;
  }
  return parsed.toISOString();
});

export const workOrderIssueLineSchema = z.object({
  lineNumber: z.number().int().positive().optional(),
  componentItemId: z.string().uuid(),
  fromLocationId: z.string().uuid(),
  uom: uomSchema.max(32),
  quantityIssued: z.number().positive(),
  reasonCode: z.string().max(64).optional(),
  notes: z.string().max(2000).optional()
});

export const workOrderIssueCreateSchema = z.object({
  occurredAt: workOrderExecutionDateSchema,
  notes: z.string().max(2000).optional(),
  lines: z.array(workOrderIssueLineSchema).min(1)
});

export const workOrderCompletionLineSchema = z.object({
  outputItemId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  uom: uomSchema.max(32),
  quantityCompleted: z.number().positive(),
  packSize: z.number().positive().optional(),
  reasonCode: z.string().max(64).optional(),
  notes: z.string().max(2000).optional()
});

export const workOrderCompletionCreateSchema = z.object({
  occurredAt: workOrderExecutionDateSchema,
  notes: z.string().max(2000).optional(),
  lines: z.array(workOrderCompletionLineSchema).min(1)
});

export const workOrderBatchSchema = z.object({
  occurredAt: workOrderExecutionDateSchema,
  notes: z.string().max(2000).optional(),
  overrideNegative: z.boolean().optional(),
  overrideReason: z.string().max(2000).optional(),
  consumeLines: z.array(
    z.object({
      componentItemId: z.string().uuid(),
      fromLocationId: z.string().uuid(),
      uom: uomSchema.max(32),
      quantity: z.number().positive(),
      reasonCode: z.string().max(64).optional(),
      notes: z.string().max(2000).optional()
    })
  ).min(1),
  produceLines: z.array(
    z.object({
      outputItemId: z.string().uuid(),
      toLocationId: z.string().uuid(),
      uom: uomSchema.max(32),
      quantity: z.number().positive(),
      packSize: z.number().positive().optional(),
      reasonCode: z.string().max(64).optional(),
      notes: z.string().max(2000).optional()
    })
  ).min(1)
});

export const workOrderIssuePostSchema = z.object({
  overrideNegative: z.boolean().optional(),
  overrideReason: z.string().max(2000).optional()
});

export const workOrderReportProductionSchema = z.object({
  warehouseId: z.string().min(1).max(64).optional(),
  outputQty: z.number().positive(),
  outputUom: uomSchema.max(32).optional(),
  outputLotId: z.string().uuid().optional(),
  outputLotCode: z.string().min(1).max(120).optional(),
  inputLots: z.array(
    z.object({
      componentItemId: z.string().uuid(),
      lotId: z.string().uuid(),
      uom: uomSchema.max(32),
      quantity: z.number().positive()
    })
  ).optional(),
  occurredAt: workOrderExecutionDateSchema.optional(),
  notes: z.string().max(2000).optional(),
  clientRequestId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
  consumptionOverrides: z.array(
    z.object({
      componentItemId: z.string().uuid(),
      uom: uomSchema.max(32),
      quantity: z.number().min(0),
      reason: z.string().max(255).optional()
    })
  ).optional(),
  scrapOutputs: z.array(
    z.object({
      uom: uomSchema.max(32),
      quantity: z.number().positive(),
      reason: z.string().max(255)
    })
  ).optional()
});

export const workOrderVoidReportProductionSchema = z.object({
  workOrderExecutionId: z.string().uuid(),
  reason: z.string().min(1).max(255),
  notes: z.string().max(2000).optional(),
  idempotencyKey: z.string().min(1).max(255).optional()
});

export const workOrderReportScrapSchema = z.object({
  workOrderExecutionId: z.string().uuid(),
  outputItemId: z.string().uuid().optional(),
  quantity: z.number().positive(),
  uom: uomSchema.max(32),
  reasonCode: z.string().min(1).max(255),
  occurredAt: workOrderExecutionDateSchema.optional(),
  notes: z.string().max(2000).optional(),
  idempotencyKey: z.string().min(1).max(255).optional()
});
