import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { purchaseOrderReceiptSchema } from '../schemas/receipts.schema';
import { createPurchaseOrderReceipt, fetchReceiptById, listReceipts, voidReceipt } from '../services/receipts.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/purchase-order-receipts', async (req: Request, res: Response) => {
  const parsed = purchaseOrderReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const tenantId = req.auth!.tenantId;
    const receipt = await createPurchaseOrderReceipt(tenantId, parsed.data, { type: 'user', id: req.auth!.userId });
    const itemIds = Array.from(new Set(receipt.lines.map((line: any) => line.itemId).filter(Boolean)));
    const locationIds = Array.from(
      new Set(
        [
          receipt.receivedToLocationId,
          ...receipt.lines.map((line: any) => line.defaultToLocationId),
          ...receipt.lines.map((line: any) => line.defaultFromLocationId)
        ].filter(Boolean)
      )
    );
    emitEvent(tenantId, 'inventory.receipt.created', {
      receiptId: receipt.id,
      purchaseOrderId: receipt.purchaseOrderId,
      itemIds,
      locationIds
    });
    return res.status(201).json(receipt);
  } catch (error: any) {
    if (error?.message === 'RECEIPT_PO_LINES_NOT_FOUND') {
      return res.status(400).json({ error: 'One or more purchase order lines were not found.' });
    }
    if (error?.message === 'RECEIPT_LINE_INVALID_REFERENCE') {
      return res.status(400).json({ error: 'Invalid purchase order line reference.' });
    }
    if (error?.message === 'RECEIPT_LINES_WRONG_PO') {
      return res
        .status(400)
        .json({ error: 'All receipt lines must reference the provided purchase order.' });
    }
    if (error?.message === 'RECEIPT_PO_ALREADY_RECEIVED') {
      return res.status(409).json({ error: 'Purchase order is already fully received/closed.' });
    }
    if (error?.message === 'RECEIPT_PO_NOT_APPROVED') {
      return res.status(400).json({ error: 'Purchase order must be approved before receiving.' });
    }
    if (error?.message === 'RECEIPT_PO_NOT_FOUND') {
      return res.status(404).json({ error: 'Purchase order not found.' });
    }
    if (error?.message === 'RECEIPT_LINE_UOM_MISMATCH') {
      return res.status(400).json({ error: 'Receipt line UOM must match the purchase order line UOM.' });
    }
    if (error?.message === 'RECEIPT_DISCREPANCY_REASON_REQUIRED') {
      return res.status(400).json({ error: 'Discrepancy reason is required when received quantity differs from expected.' });
    }
    if (error?.message === 'RECEIPT_NOT_FOUND_AFTER_CREATE') {
      return res
        .status(500)
        .json({ error: 'Receipt was created but could not be reloaded. Please retry fetch.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({
        status: 400,
        body: { error: 'Referenced purchase order, line, or location does not exist.' }
      }),
      check: () => ({ status: 400, body: { error: 'Quantity received must be greater than zero.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create purchase order receipt.' });
  }
});

router.get('/purchase-order-receipts/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid receipt id.' });
  }
  try {
    const receipt = await fetchReceiptById(req.auth!.tenantId, id);
    if (!receipt) {
      return res.status(404).json({ error: 'Receipt not found.' });
    }
    return res.json(receipt);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch receipt.' });
  }
});

router.get('/purchase-order-receipts', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const status = typeof req.query.status === 'string' && req.query.status.trim() ? req.query.status.trim() : undefined;
  const vendorId = typeof req.query.vendorId === 'string' && req.query.vendorId.trim() ? req.query.vendorId.trim() : undefined;
  const from = typeof req.query.from === 'string' && req.query.from.trim() ? req.query.from.trim() : undefined;
  const to = typeof req.query.to === 'string' && req.query.to.trim() ? req.query.to.trim() : undefined;
  const search = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim() : undefined;
  const includeLines =
    typeof req.query.includeLines === 'string'
      ? req.query.includeLines === 'true'
      : Boolean(req.query.includeLines);
  try {
    const rows = await listReceipts(req.auth!.tenantId, {
      limit,
      offset,
      status,
      vendorId,
      from,
      to,
      search,
      includeLines
    });
    return res.json({ data: rows, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list receipts.' });
  }
});

router.delete('/purchase-order-receipts/:id', async (req: Request, res: Response) => {
  return res
    .status(409)
    .json({ error: 'Receipt deletes are disabled. Use the void endpoint instead.' });
});

router.post('/purchase-order-receipts/:id/void', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid receipt id.' });
  }
  try {
    const tenantId = req.auth!.tenantId;
    const receipt = await voidReceipt(tenantId, id, {
      type: 'user',
      id: req.auth!.userId
    });
    emitEvent(tenantId, 'inventory.receipt.voided', { receiptId: id });
    return res.json(receipt);
  } catch (error: any) {
    if (error?.message === 'RECEIPT_NOT_FOUND') {
      return res.status(404).json({ error: 'Receipt not found.' });
    }
    if (error?.message === 'RECEIPT_ALREADY_VOIDED') {
      return res.status(409).json({ error: 'Receipt is already voided.' });
    }
    if (error?.message === 'RECEIPT_HAS_PUTAWAYS_POSTED') {
      return res.status(409).json({ error: 'Receipt has posted putaway lines and cannot be voided.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to void receipt.' });
  }
});

export default router;
