import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrderById,
  listPurchaseOrders,
  updatePurchaseOrder
} from '../services/purchaseOrders.service';
import { purchaseOrderSchema, purchaseOrderUpdateSchema } from '../schemas/purchaseOrders.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/purchase-orders', async (req: Request, res: Response) => {
  const parsed = purchaseOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const tenantId = req.auth!.tenantId;
    const purchaseOrder = await createPurchaseOrder(tenantId, parsed.data, { type: 'user', id: req.auth!.userId });
    const itemIds = Array.from(new Set(purchaseOrder.lines.map((line) => line.itemId)));
    const locationIds = Array.from(
      new Set([purchaseOrder.shipToLocationId, purchaseOrder.receivingLocationId].filter(Boolean))
    );
    emitEvent(tenantId, 'inventory.purchase_order.created', {
      purchaseOrderId: purchaseOrder.id,
      status: purchaseOrder.status,
      itemIds,
      locationIds
    });
    return res.status(201).json(purchaseOrder);
  } catch (error: any) {
    if (error?.message?.startsWith?.('PO_SUBMIT_')) {
      return res.status(409).json({ error: 'Purchase order is not ready to submit.' });
    }
    if (error?.message === 'PO_DUPLICATE_LINE_NUMBERS') {
      return res.status(400).json({ error: 'Line numbers must be unique within a purchase order.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'PO number must be unique.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Referenced vendor, item, or location does not exist.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create purchase order.' });
  }
});

router.get('/purchase-orders/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid purchase order id.' });
  }

  try {
    const po = await getPurchaseOrderById(req.auth!.tenantId, id);
    if (!po) {
      return res.status(404).json({ error: 'Purchase order not found.' });
    }
    return res.json(po);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch purchase order.' });
  }
});

router.get('/purchase-orders', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  try {
    const rows = await listPurchaseOrders(req.auth!.tenantId, limit, offset);
    return res.json({ data: rows, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list purchase orders.' });
  }
});

router.put('/purchase-orders/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid purchase order id.' });
  }
  const parsed = purchaseOrderUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const tenantId = req.auth!.tenantId;
    const po = await updatePurchaseOrder(tenantId, id, parsed.data, { type: 'user', id: req.auth!.userId });
    const itemIds = Array.from(new Set(po.lines.map((line) => line.itemId)));
    const locationIds = Array.from(new Set([po.shipToLocationId, po.receivingLocationId].filter(Boolean)));
    emitEvent(tenantId, 'inventory.purchase_order.updated', {
      purchaseOrderId: po.id,
      status: po.status,
      itemIds,
      locationIds
    });
    return res.json(po);
  } catch (error: any) {
    if (error?.message === 'PO_NOT_FOUND') {
      return res.status(404).json({ error: 'Purchase order not found.' });
    }
    if (error?.message === 'PO_LINES_LOCKED') {
      return res.status(409).json({ error: 'Purchase order lines are locked after submission.' });
    }
    if (error?.message === 'PO_EDIT_LOCKED') {
      return res.status(409).json({ error: 'Purchase order is locked after submission.' });
    }
    if (error?.message === 'PO_STATUS_INVALID_TRANSITION') {
      return res.status(409).json({ error: 'Invalid purchase order status transition.' });
    }
    if (error?.message === 'PO_CANCEL_USE_ENDPOINT') {
      return res.status(409).json({ error: 'Use the cancel endpoint to cancel a purchase order.' });
    }
    if (error?.message === 'PO_APPROVE_USE_ENDPOINT') {
      return res.status(409).json({ error: 'Use the approve endpoint to approve a purchase order.' });
    }
    if (error?.message === 'PO_STATUS_MANAGED_BY_RECEIPTS') {
      return res.status(409).json({ error: 'Purchase order status is managed by receipts.' });
    }
    if (error?.message?.startsWith?.('PO_SUBMIT_')) {
      return res.status(409).json({ error: 'Purchase order is not ready to submit.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Referenced vendor, item, or location does not exist.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to update purchase order.' });
  }
});

router.post('/purchase-orders/:id/approve', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid purchase order id.' });
  }
  try {
    const tenantId = req.auth!.tenantId;
    const po = await approvePurchaseOrder(tenantId, id, { type: 'user', id: req.auth!.userId });
    const itemIds = Array.from(new Set(po.lines.map((line) => line.itemId)));
    const locationIds = Array.from(new Set([po.shipToLocationId, po.receivingLocationId].filter(Boolean)));
    emitEvent(tenantId, 'inventory.purchase_order.approved', {
      purchaseOrderId: po.id,
      status: po.status,
      itemIds,
      locationIds
    });
    return res.json(po);
  } catch (error: any) {
    if (error?.message === 'PO_NOT_FOUND') {
      return res.status(404).json({ error: 'Purchase order not found.' });
    }
    if (error?.message === 'PO_ALREADY_APPROVED') {
      return res.status(409).json({ error: 'Purchase order is already approved.' });
    }
    if (error?.message === 'PO_NOT_SUBMITTED') {
      return res.status(400).json({ error: 'Purchase order must be submitted before approval.' });
    }
    if (error?.message === 'PO_NOT_ELIGIBLE') {
      return res.status(400).json({ error: 'Purchase order cannot be approved in its current state.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to approve purchase order.' });
  }
});

router.delete('/purchase-orders/:id', async (req: Request, res: Response) => {
  return res
    .status(409)
    .json({ error: 'Purchase order deletes are disabled. Use the cancel endpoint instead.' });
});

router.post('/purchase-orders/:id/cancel', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid purchase order id.' });
  }
  try {
    const tenantId = req.auth!.tenantId;
    const po = await cancelPurchaseOrder(tenantId, id, { type: 'user', id: req.auth!.userId });
    emitEvent(tenantId, 'inventory.purchase_order.canceled', { purchaseOrderId: id, status: po.status });
    return res.json(po);
  } catch (error: any) {
    if (error?.message === 'PO_NOT_FOUND') {
      return res.status(404).json({ error: 'Purchase order not found.' });
    }
    if (error?.message === 'PO_ALREADY_CANCELED') {
      return res.status(409).json({ error: 'Purchase order already canceled.' });
    }
    if (error?.message === 'PO_NOT_ELIGIBLE') {
      return res.status(409).json({ error: 'Purchase order cannot be canceled in its current state.' });
    }
    if (error?.message === 'PO_HAS_RECEIPTS') {
      return res.status(409).json({ error: 'Purchase order has receipts and cannot be canceled.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to cancel purchase order.' });
  }
});

export default router;
