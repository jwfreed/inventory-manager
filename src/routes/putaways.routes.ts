import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { putawaySchema } from '../schemas/putaways.schema';
import { createPutaway, fetchPutawayById, postPutaway } from '../services/putaways.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/putaways', async (req: Request, res: Response) => {
  const parsed = putawaySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const putaway = await createPutaway(req.auth!.tenantId, parsed.data);
    return res.status(201).json(putaway);
  } catch (error: any) {
    if (error?.message === 'PUTAWAY_LINES_NOT_FOUND') {
      return res.status(400).json({ error: 'One or more receipt lines were not found.' });
    }
    if (error?.message === 'PUTAWAY_UOM_MISMATCH') {
      return res.status(400).json({ error: 'Putaway line UOM must match the receipt line UOM.' });
    }
    if (error?.message === 'PUTAWAY_FROM_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'fromLocationId is required when the receipt lacks a staging location.' });
    }
    if (error?.message === 'PUTAWAY_SAME_LOCATION') {
      return res.status(400).json({ error: 'Source and destination locations must differ.' });
    }
    if (error?.message === 'PUTAWAY_BLOCKED') {
      return res.status(409).json({ error: 'QC hold or missing acceptance prevents planning this putaway.' });
    }
    if (error?.message === 'PUTAWAY_QUANTITY_EXCEEDED') {
      const lineId = error?.lineId ? ` for receipt line ${error.lineId}` : '';
      return res.status(409).json({ error: `Requested quantity exceeds available putaway quantity${lineId}.` });
    }
    if (error?.message === 'PUTAWAY_RECEIPT_REQUIRED') {
      return res.status(400).json({ error: 'purchaseOrderReceiptId is required for receipt-based putaways.' });
    }
    if (error?.message === 'PUTAWAY_NOT_FOUND_AFTER_CREATE') {
      return res.status(500).json({ error: 'Putaway was created but could not be reloaded.' });
    }
    if (error?.message === 'PUTAWAY_DUPLICATE_LINE') {
      return res.status(400).json({ error: 'Line numbers must be unique within a putaway.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({
        status: 400,
        body: { error: 'Invalid reference: ensure locations, items, and receipt lines exist before putaway.' }
      })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create putaway.' });
  }
});

router.get('/putaways/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid putaway id.' });
  }

  try {
    const putaway = await fetchPutawayById(req.auth!.tenantId, id);
    if (!putaway) {
      return res.status(404).json({ error: 'Putaway not found.' });
    }
    return res.json(putaway);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch putaway.' });
  }
});

router.post('/putaways/:id/post', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid putaway id.' });
  }

  try {
    const tenantId = req.auth!.tenantId;
    const putaway = await postPutaway(tenantId, id);
    const itemIds = Array.from(new Set(putaway.lines.map((line) => line.itemId)));
    const locationIds = Array.from(
      new Set(
        putaway.lines.flatMap((line) => [line.fromLocationId, line.toLocationId])
      )
    );
    emitEvent(tenantId, 'inventory.putaway.posted', {
      putawayId: putaway.id,
      movementId: putaway.inventoryMovementId,
      itemIds,
      locationIds
    });
    return res.json(putaway);
  } catch (error: any) {
    if (error?.message === 'PUTAWAY_NOT_FOUND') {
      return res.status(404).json({ error: 'Putaway not found.' });
    }
    if (error?.message === 'PUTAWAY_ALREADY_POSTED') {
      return res.status(409).json({ error: 'Putaway already posted.' });
    }
    if (error?.message === 'PUTAWAY_CANCELED') {
      return res.status(400).json({ error: 'Canceled putaways cannot be posted.' });
    }
    if (error?.message === 'PUTAWAY_NO_LINES') {
      return res.status(400).json({ error: 'Putaway has no lines to post.' });
    }
    if (error?.message === 'PUTAWAY_NOTHING_TO_POST') {
      return res.status(400).json({ error: 'All putaway lines are already completed or canceled.' });
    }
    if (error?.message === 'PUTAWAY_INVALID_QUANTITY') {
      return res.status(400).json({ error: 'Putaway line quantity must be greater than zero before posting.' });
    }
    if (error?.message === 'PUTAWAY_QC_BLOCKED') {
      return res.status(409).json({ error: 'QC hold or missing acceptance prevents posting this putaway.' });
    }
    if (error?.message === 'PUTAWAY_QUANTITY_EXCEEDED') {
      return res.status(409).json({ error: 'Putaway quantity exceeds available accepted quantity.' });
    }
    if (error?.message === 'PUTAWAY_ACCEPT_LIMIT') {
      return res.status(409).json({ error: 'Requested putaway quantity exceeds accepted quantity.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post putaway.' });
  }
});

export default router;
