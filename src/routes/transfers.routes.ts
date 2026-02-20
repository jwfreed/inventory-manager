import { Router, type Request, type Response } from 'express';
import { inventoryTransferCreateSchema } from '../schemas/transfers.schema';
import { postInventoryTransfer } from '../services/transfers.service';
import { getIdempotencyKey } from '../lib/idempotency';
import { invalidateAtpCacheForWarehouse } from '../services/atpCache.service';
import { mapTxRetryExhausted } from './orderToCash.shipmentConflicts';

const router = Router();

router.post('/inventory-transfers', async (req: Request, res: Response) => {
  const parsed = inventoryTransferCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const idempotencyKey = getIdempotencyKey(req);

  try {
    const result = await postInventoryTransfer({
      tenantId: req.auth!.tenantId,
      sourceLocationId: parsed.data.sourceLocationId,
      destinationLocationId: parsed.data.destinationLocationId,
      itemId: parsed.data.itemId,
      quantity: parsed.data.quantity,
      uom: parsed.data.uom,
      reasonCode: parsed.data.reasonCode ?? 'transfer',
      notes: parsed.data.notes ?? 'Inventory transfer',
      occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : undefined,
      actorId: req.auth?.userId ?? null,
      overrideNegative: parsed.data.overrideNegative ?? false,
      overrideReason: parsed.data.overrideReason ?? null,
      idempotencyKey
    });
    invalidateAtpCacheForWarehouse(req.auth!.tenantId, result.sourceWarehouseId);
    invalidateAtpCacheForWarehouse(req.auth!.tenantId, result.destinationWarehouseId);

    return res.status(result.created ? 201 : 200).json({
      movementId: result.movementId
    });
  } catch (error: any) {
    if (mapTxRetryExhausted(error, res)) {
      return;
    }
    if (error?.code === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({
        error: { code: 'INSUFFICIENT_STOCK', message: error.details?.message, details: error.details }
      });
    }
    if (error?.code === 'NEGATIVE_OVERRIDE_NOT_ALLOWED') {
      return res.status(403).json({
        error: {
          code: 'NEGATIVE_OVERRIDE_NOT_ALLOWED',
          message: error.details?.message,
          details: error.details
        }
      });
    }
    if (error?.code === 'NEGATIVE_OVERRIDE_REQUIRES_REASON') {
      return res.status(409).json({
        error: {
          code: 'NEGATIVE_OVERRIDE_REQUIRES_REASON',
          message: error.details?.message,
          details: error.details
        }
      });
    }
    if (error?.code === 'INV_TRANSFER_IDEMPOTENCY_CONFLICT' || error?.message === 'INV_TRANSFER_IDEMPOTENCY_CONFLICT') {
      return res.status(409).json({
        error: {
          code: 'INV_TRANSFER_IDEMPOTENCY_CONFLICT',
          message: 'Idempotency key payload conflict detected for inventory transfer posting.',
          details: error?.details
        }
      });
    }
    if (error?.code === 'INV_TRANSFER_IDEMPOTENCY_INCOMPLETE' || error?.message === 'INV_TRANSFER_IDEMPOTENCY_INCOMPLETE') {
      return res.status(409).json({
        error: {
          code: 'INV_TRANSFER_IDEMPOTENCY_INCOMPLETE',
          message: 'Inventory transfer posting is incomplete for this idempotency key.',
          details: error?.details
        }
      });
    }
    if (error?.message === 'TRANSFER_SAME_LOCATION') {
      return res.status(400).json({ error: 'Source and destination must differ.' });
    }
    if (error?.message === 'TRANSFER_INVALID_QUANTITY') {
      return res.status(400).json({ error: 'Transfer quantity must be greater than zero.' });
    }
    if (error?.message === 'TRANSFER_SOURCE_NOT_FOUND') {
      return res.status(404).json({ error: 'Source location not found.' });
    }
    if (error?.message === 'TRANSFER_DESTINATION_NOT_FOUND') {
      return res.status(404).json({ error: 'Destination location not found.' });
    }
    if (error?.message === 'TRANSFER_CANONICAL_MISMATCH') {
      return res.status(409).json({ error: 'Transfer canonical quantity mismatch.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post inventory transfer.' });
  }
});

export default router;
