import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createReservations,
  allocateReservation,
  cancelReservation,
  fulfillReservation,
  createReturnAuthorization,
  createSalesOrder,
  createShipment,
  postShipment,
  getReservation,
  getReturnAuthorization,
  getSalesOrder,
  getShipment,
  listReservations,
  listReturnAuthorizations,
  listSalesOrders,
  listShipments,
} from '../services/orderToCash.service';
import {
  reservationsCreateSchema,
  returnAuthorizationSchema,
  salesOrderSchema,
  shipmentSchema,
} from '../schemas/orderToCash.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';
import { getIdempotencyKey } from '../lib/idempotency';

const router = Router();
const uuidSchema = z.string().uuid();
const reservationCancelSchema = z.object({
  warehouseId: z.string().uuid(),
  reason: z.string().max(1000).optional(),
});
const reservationFulfillSchema = z.object({
  quantity: z.number(),
});
const reservationAllocateSchema = z.object({
  warehouseId: z.string().uuid()
});

function requireWarehouseId(
  warehouseId: unknown,
  res: Response
): warehouseId is string {
  if (typeof warehouseId === 'string' && warehouseId.trim().length > 0) return true;
  res.status(400).json({
    error: {
      code: 'WAREHOUSE_ID_REQUIRED',
      message: 'warehouseId is required.'
    }
  });
  return false;
}

router.post('/sales-orders', async (req: Request, res: Response) => {
  const parsed = salesOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const order = await createSalesOrder(req.auth!.tenantId, parsed.data);
    return res.status(201).json(order);
  } catch (error: any) {
    if (error?.message === 'DUPLICATE_LINE_NUMBER') {
      return res.status(400).json({ error: 'Line numbers must be unique within a sales order.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'so_number must be unique.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Referenced customer, item, or location not found.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid quantity or status.' } }),
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create sales order.' });
  }
});

router.get('/sales-orders', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const customerId =
    typeof req.query.customerId === 'string' && uuidSchema.safeParse(req.query.customerId).success
      ? (req.query.customerId as string)
      : undefined;
  try {
    const rows = await listSalesOrders(req.auth!.tenantId, limit, offset, { status, customerId });
    return res.json({ data: rows, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list sales orders.' });
  }
});

router.get('/sales-orders/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid sales order id.' });
  }
  try {
    const order = await getSalesOrder(req.auth!.tenantId, id);
    if (!order) return res.status(404).json({ error: 'Sales order not found.' });
    return res.json(order);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch sales order.' });
  }
});

router.post('/reservations', async (req: Request, res: Response) => {
  const reservations = Array.isArray(req.body?.reservations) ? req.body.reservations : [];
  if (!reservations.length || reservations.some((entry: any) => !entry?.warehouseId)) {
    return res.status(400).json({
      error: {
        code: 'WAREHOUSE_ID_REQUIRED',
        message: 'warehouseId is required for each reservation.'
      }
    });
  }

  const parsed = reservationsCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const tenantId = req.auth!.tenantId;
    const idempotencyKey = getIdempotencyKey(req);
    const results = await createReservations(tenantId, parsed.data, { idempotencyKey });
    const reservationIds = results.map((r) => r.id);
    const itemIds = Array.from(new Set(results.map((r) => r.itemId).filter(Boolean)));
    const locationIds = Array.from(new Set(results.map((r) => r.locationId).filter(Boolean)));
    emitEvent(tenantId, 'inventory.reservation.created', {
      reservationIds,
      itemIds,
      locationIds
    });
    return res.status(201).json({ data: results });
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Referenced item, location, or demand not found.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid reservation status or quantities.' } }),
      unique: () => ({ status: 409, body: { error: 'Reservation already exists for demand/item/location/uom.' } }),
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    if ((error as Error)?.message === 'RESERVATION_LOCATION_NOT_SELLABLE') {
      return res.status(409).json({ error: 'Reservation location must be sellable.' });
    }
    if ((error as Error)?.message === 'RESERVATION_LOCATION_NOT_FOUND') {
      return res.status(400).json({ error: 'Reservation location not found.' });
    }
    if ((error as Error)?.message === 'RESERVATION_INSUFFICIENT_AVAILABLE') {
      return res.status(409).json({ error: 'Insufficient sellable inventory for reservation.' });
    }
    if ((error as Error)?.message === 'RESERVATION_WAREHOUSE_MISMATCH') {
      return res.status(409).json({ error: 'Reservation warehouse does not match reservation location.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create reservation.' });
  }
});

router.post('/reservations/:id/allocate', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid reservation id.' });
  }
  if (!requireWarehouseId(req.body?.warehouseId, res)) {
    return;
  }
  const parsed = reservationAllocateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const idempotencyKey = getIdempotencyKey(req);
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required.' });
  }
  try {
    const reservation = await allocateReservation(req.auth!.tenantId, id, parsed.data.warehouseId, { idempotencyKey });
    if (!reservation) return res.status(404).json({ error: 'Reservation not found.' });
    return res.json(reservation);
  } catch (error: any) {
    if (error?.message === 'RESERVATION_NOT_FOUND') {
      return res.status(404).json({ error: 'Reservation not found.' });
    }
    if (error?.message === 'RESERVATION_INVALID_TRANSITION' || error?.message === 'RESERVATION_INVALID_STATE') {
      return res.status(409).json({ error: 'Reservation cannot be allocated from current state.' });
    }
    if (error?.message === 'RESERVATION_ALLOCATE_IN_PROGRESS') {
      return res.status(409).json({ error: 'Reservation allocation already in progress.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to allocate reservation.' });
  }
});

router.post('/reservations/:id/cancel', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid reservation id.' });
  }
  if (!requireWarehouseId(req.body?.warehouseId, res)) {
    return;
  }
  const parsed = reservationCancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const idempotencyKey = getIdempotencyKey(req);
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required.' });
  }
  try {
    const reservation = await cancelReservation(req.auth!.tenantId, id, parsed.data.warehouseId, {
      reason: parsed.data.reason ?? null,
      idempotencyKey
    });
    if (!reservation) return res.status(404).json({ error: 'Reservation not found.' });
    return res.json(reservation);
  } catch (error: any) {
    if (error?.message === 'RESERVATION_NOT_FOUND') {
      return res.status(404).json({ error: 'Reservation not found.' });
    }
    if (error?.message === 'RESERVATION_INVALID_STATE' || error?.message === 'RESERVATION_ALLOCATED_CANCEL_FORBIDDEN') {
      return res.status(409).json({ error: 'Reservation cannot be canceled from current state.' });
    }
    if (error?.message === 'RESERVATION_CANCEL_IN_PROGRESS') {
      return res.status(409).json({ error: 'Reservation cancel already in progress.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to cancel reservation.' });
  }
});

router.post('/reservations/:id/fulfill', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid reservation id.' });
  }
  const warehouseId = req.body?.warehouseId;
  if (!requireWarehouseId(warehouseId, res)) {
    return;
  }
  const parsed = reservationFulfillSchema.safeParse({ quantity: req.body?.quantity });
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const idempotencyKey = getIdempotencyKey(req);
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required.' });
  }
  try {
    const reservation = await fulfillReservation(req.auth!.tenantId, id, warehouseId, {
      quantity: parsed.data.quantity,
      idempotencyKey
    });
    if (!reservation) return res.status(404).json({ error: 'Reservation not found.' });
    return res.json(reservation);
  } catch (error: any) {
    if (error?.message === 'RESERVATION_NOT_FOUND') {
      return res.status(404).json({ error: 'Reservation not found.' });
    }
    if (error?.message === 'RESERVATION_INVALID_QUANTITY') {
      return res.status(400).json({
        error: {
          code: 'RESERVATION_INVALID_QUANTITY',
          message: 'quantity must be a positive number.'
        }
      });
    }
    if (error?.message === 'RESERVATION_INVALID_TRANSITION' || error?.message === 'RESERVATION_INVALID_STATE') {
      return res.status(409).json({ error: 'Reservation cannot be fulfilled from current state.' });
    }
    if (error?.message === 'RESERVATION_FULFILL_IN_PROGRESS') {
      return res.status(409).json({ error: 'Reservation fulfill already in progress.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to fulfill reservation.' });
  }
});

router.post('/shipments/:id/post', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid shipment id.' });
  }
  const idempotencyKey = getIdempotencyKey(req);
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required.' });
  }

  try {
    const tenantId = req.auth!.tenantId;
    const overrideRequested = !!req.body?.overrideNegative;
    const overrideReason = req.body?.overrideReason ?? null;
    const shipment = await postShipment(tenantId, id, {
      idempotencyKey,
      actor: { type: 'user', id: req.auth!.userId, role: req.auth!.role },
      overrideRequested,
      overrideReason
    });
    emitEvent(tenantId, 'inventory.shipment.posted', {
      shipmentId: shipment.id,
      movementId: shipment.inventoryMovementId,
      locationId: shipment.shipFromLocationId
    });
    return res.json(shipment);
  } catch (error: any) {
    if (error?.code === 'INSUFFICIENT_STOCK' || error?.message === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({ error: 'Insufficient stock to post shipment.', details: error?.details });
    }
    if (error?.code === 'NEGATIVE_OVERRIDE_NOT_ALLOWED') {
      return res.status(403).json({ error: error.details?.message ?? 'Negative override not allowed.', details: error?.details });
    }
    if (error?.code === 'NEGATIVE_OVERRIDE_REQUIRES_REASON') {
      return res.status(409).json({ error: error.details?.message ?? 'Negative override requires a reason.', details: error?.details });
    }
    if (error?.message === 'SHIPMENT_NOT_FOUND') {
      return res.status(404).json({ error: 'Shipment not found.' });
    }
    if (error?.message === 'SHIPMENT_CANCELED') {
      return res.status(409).json({ error: 'Canceled shipments cannot be posted.' });
    }
    if (error?.message === 'SHIPMENT_NO_LINES') {
      return res.status(400).json({ error: 'Shipment has no lines to post.' });
    }
    if (error?.message === 'SHIPMENT_INVALID_QUANTITY') {
      return res.status(400).json({ error: 'Shipment quantities must be greater than zero.' });
    }
    if (error?.message === 'SHIPMENT_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Shipment requires ship_from_location_id.' });
    }
    if (error?.message === 'RESERVATION_INVALID_STATE') {
      return res.status(409).json({ error: 'Reservation state changed while posting shipment. Please retry.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post shipment.' });
  }
});

router.get('/reservations', async (req: Request, res: Response) => {
  const warehouseId = Array.isArray(req.query.warehouseId) ? req.query.warehouseId[0] : req.query.warehouseId;
  if (!requireWarehouseId(warehouseId, res)) {
    return;
  }
  if (!uuidSchema.safeParse(warehouseId).success) {
    return res.status(400).json({ error: 'Invalid warehouseId.' });
  }
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const rows = await listReservations(req.auth!.tenantId, warehouseId, limit, offset);
    return res.json({ data: rows, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list reservations.' });
  }
});

router.get('/reservations/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid reservation id.' });
  }
  const warehouseId = Array.isArray(req.query.warehouseId) ? req.query.warehouseId[0] : req.query.warehouseId;
  if (!requireWarehouseId(warehouseId, res)) {
    return;
  }
  if (!uuidSchema.safeParse(warehouseId).success) {
    return res.status(400).json({ error: 'Invalid warehouseId.' });
  }
  try {
    const reservation = await getReservation(req.auth!.tenantId, id, warehouseId);
    if (!reservation) return res.status(404).json({ error: 'Reservation not found.' });
    return res.json(reservation);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch reservation.' });
  }
});

router.post('/shipments', async (req: Request, res: Response) => {
  const parsed = shipmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const shipment = await createShipment(req.auth!.tenantId, parsed.data);
    return res.status(201).json(shipment);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({
        status: 400,
        body: { error: 'Referenced sales order, line, item, or location not found.' },
      }),
      check: () => ({ status: 400, body: { error: 'Invalid shipment quantities.' } }),
      unique: () => ({ status: 409, body: { error: 'Inventory movement already linked.' } }),
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create shipment.' });
  }
});

router.get('/shipments', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const rows = await listShipments(req.auth!.tenantId, limit, offset);
    return res.json({ data: rows, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list shipments.' });
  }
});

router.get('/shipments/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid shipment id.' });
  }
  try {
    const shipment = await getShipment(req.auth!.tenantId, id);
    if (!shipment) return res.status(404).json({ error: 'Shipment not found.' });
    return res.json(shipment);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch shipment.' });
  }
});

router.post('/returns', async (req: Request, res: Response) => {
  const parsed = returnAuthorizationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const rma = await createReturnAuthorization(req.auth!.tenantId, parsed.data);
    return res.status(201).json(rma);
  } catch (error: any) {
    if (error?.message === 'DUPLICATE_LINE_NUMBER') {
      return res.status(400).json({ error: 'Line numbers must be unique within a return authorization.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'rma_number must be unique.' } }),
      foreignKey: () => ({
        status: 400,
        body: { error: 'Referenced customer, sales order, item, or line not found.' },
      }),
      check: () => ({ status: 400, body: { error: 'Invalid quantities or status.' } }),
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create return authorization.' });
  }
});

router.get('/returns', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const rows = await listReturnAuthorizations(req.auth!.tenantId, limit, offset);
    return res.json({ data: rows, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list returns.' });
  }
});

router.get('/returns/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid return id.' });
  }
  try {
    const rma = await getReturnAuthorization(req.auth!.tenantId, id);
    if (!rma) return res.status(404).json({ error: 'Return not found.' });
    return res.json(rma);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch return.' });
  }
});

export default router;
