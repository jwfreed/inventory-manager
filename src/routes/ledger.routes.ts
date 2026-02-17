import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { movementListQuerySchema, movementWindowQuerySchema } from '../schemas/ledger.schema';
import { getMovement, getMovementLines, getMovementWindow, listMovements } from '../services/ledger.service';
import { voidTransferMovement } from '../services/transfers.service';
import { getIdempotencyKey } from '../lib/idempotency';

const router = Router();
const uuidSchema = z.string().uuid();
const transferVoidSchema = z.object({
  reason: z.string().min(1).max(2000)
});

router.get('/inventory-movements', async (req: Request, res: Response) => {
  const parsed = movementListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { movement_type, status, external_ref, occurred_from, occurred_to, item_id, location_id, limit, offset } =
    parsed.data;

  try {
    const data = await listMovements(req.auth!.tenantId, {
      movementType: movement_type,
      status,
      externalRef: external_ref,
      occurredFrom: occurred_from,
      occurredTo: occurred_to,
      itemId: item_id,
      locationId: location_id,
      limit: limit ?? 50,
      offset: offset ?? 0
    });
    return res.json({ data, paging: { limit: limit ?? 50, offset: offset ?? 0 } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list inventory movements.' });
  }
});

router.get('/inventory-movements/window', async (req: Request, res: Response) => {
  const parsed = movementWindowQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (!parsed.data.item_id && !parsed.data.location_id) {
    return res.status(400).json({ error: 'item_id or location_id is required.' });
  }
  try {
    const window = await getMovementWindow(req.auth!.tenantId, {
      itemId: parsed.data.item_id,
      locationId: parsed.data.location_id
    });
    return res.json({ data: window });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load inventory movement window.' });
  }
});

router.get('/inventory-movements/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid movement id.' });
  }
  try {
    const movement = await getMovement(req.auth!.tenantId, id);
    if (!movement) return res.status(404).json({ error: 'Inventory movement not found.' });
    return res.json(movement);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch inventory movement.' });
  }
});

router.get('/inventory-movements/:id/lines', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid movement id.' });
  }
  try {
    const lines = await getMovementLines(req.auth!.tenantId, id);
    return res.json({ data: lines });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch inventory movement lines.' });
  }
});

router.post('/inventory-movements/:id/void-transfer', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid movement id.' });
  }
  const parsed = transferVoidSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const result = await voidTransferMovement(req.auth!.tenantId, id, {
      reason: parsed.data.reason,
      actor: { type: 'user', id: req.auth!.userId },
      idempotencyKey: getIdempotencyKey(req)
    });
    return res.status(201).json(result);
  } catch (error: any) {
    if (error?.code === 'TX_RETRY_EXHAUSTED') {
      return res.status(409).json({
        error: {
          code: 'TX_RETRY_EXHAUSTED',
          message: 'High write contention detected. Please retry.'
        }
      });
    }
    if (error?.message === 'TRANSFER_NOT_FOUND') {
      return res.status(404).json({ error: 'Transfer movement not found.' });
    }
    if (error?.message === 'TRANSFER_NOT_TRANSFER') {
      return res.status(409).json({ error: 'Only transfer movements can be voided here.' });
    }
    if (error?.message === 'TRANSFER_NOT_POSTED') {
      return res.status(409).json({ error: 'Only posted transfer movements can be voided.' });
    }
    if (error?.message === 'TRANSFER_ALREADY_REVERSED') {
      return res.status(409).json({ error: 'Transfer is already reversed.' });
    }
    if (error?.message === 'TRANSFER_REVERSAL_INVALID_TARGET') {
      return res.status(409).json({ error: 'Cannot reverse a reversal movement.' });
    }
    if (error?.message === 'TRANSFER_REVERSAL_NOT_POSSIBLE_CONSUMED') {
      return res.status(409).json({ error: 'Transfer reversal is blocked because destination layers were consumed.' });
    }
    if (error?.message === 'TRANSFER_VOID_REASON_REQUIRED') {
      return res.status(400).json({ error: 'reason is required.' });
    }
    if (error?.message === 'TRANSFER_VOID_CONFLICT') {
      return res.status(409).json({ error: 'Transfer void conflict.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to void transfer movement.' });
  }
});

export default router;
