import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createReservations,
  createReturnAuthorization,
  createSalesOrder,
  createShipment,
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

const router = Router();
const uuidSchema = z.string().uuid();

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
  const parsed = reservationsCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const tenantId = req.auth!.tenantId;
    const results = await createReservations(tenantId, parsed.data);
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
    console.error(error);
    return res.status(500).json({ error: 'Failed to create reservation.' });
  }
});

router.get('/reservations', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const rows = await listReservations(req.auth!.tenantId, limit, offset);
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
  try {
    const reservation = await getReservation(req.auth!.tenantId, id);
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
