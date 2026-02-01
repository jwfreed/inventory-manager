import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { qcEventSchema } from '../schemas/qc.schema';
import { 
  createQcEvent, 
  getQcEventById, 
  listQcEventsForLine, 
  listQcEventsForWorkOrder, 
  listQcEventsForExecutionLine 
} from '../services/qc.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { getIdempotencyKey } from '../lib/idempotency';
import { beginIdempotency, completeIdempotency, hashRequestBody } from '../lib/idempotencyStore';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/qc-events', async (req: Request, res: Response) => {
  const parsed = qcEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const idempotencyKey = getIdempotencyKey(req);
  let idempotencyStarted = false;

  try {
    if (idempotencyKey) {
      const record = await beginIdempotency(idempotencyKey, hashRequestBody(req.body));
      if (record.status === 'SUCCEEDED' && record.responseRef) {
        const [kind, id] = record.responseRef.split(':');
        if (kind === 'qc_event') {
          const existing = await getQcEventById(req.auth!.tenantId, id);
          if (existing) {
            return res.status(200).json(existing);
          }
        }
        return res.status(409).json({ error: 'QC event already processed for this request.' });
      }
      if (record.status === 'IN_PROGRESS') {
        return res.status(409).json({ error: 'QC event already in progress for this key.' });
      }
      idempotencyStarted = true;
    }
    const event = await createQcEvent(req.auth!.tenantId, parsed.data);
    if (idempotencyKey && idempotencyStarted) {
      await completeIdempotency(idempotencyKey, 'SUCCEEDED', `qc_event:${event.id}`);
    }
    return res.status(201).json(event);
  } catch (error: any) {
    if (idempotencyKey && idempotencyStarted) {
      await completeIdempotency(idempotencyKey, 'FAILED', null);
    }
    if (error?.message === 'QC_LINE_NOT_FOUND') {
      return res.status(404).json({ error: 'Receipt line not found.' });
    }
    if (error?.message === 'QC_WORK_ORDER_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    if (error?.message === 'QC_EXECUTION_LINE_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order execution line not found.' });
    }
    if (error?.message === 'QC_RECEIPT_VOIDED') {
      return res.status(409).json({ error: 'Receipt is voided; QC events are not allowed.' });
    }
    if (error?.message === 'QC_RECEIPT_NOT_ELIGIBLE') {
      return res.status(409).json({ error: 'Receipt is not eligible for QC events.' });
    }
    if (error?.message === 'QC_UOM_MISMATCH') {
      return res.status(400).json({ error: 'QC event UOM must match the source UOM.' });
    }
    if (error?.message === 'QC_EXCEEDS_RECEIPT') {
      return res.status(400).json({ error: 'QC quantities cannot exceed the received quantity for the line.' });
    }
    if (error?.message === 'QC_EXCEEDS_EXECUTION') {
      return res.status(400).json({ error: 'QC quantities cannot exceed the execution quantity.' });
    }
    if (error?.message === 'QC_EXCEEDS_WORK_ORDER') {
      return res.status(400).json({ error: 'QC quantities cannot exceed the work order completed quantity.' });
    }
    if (error?.message === 'QC_ACCEPT_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Source has no receiving location to post accepted inventory.' });
    }
    if (error?.message === 'QC_HOLD_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Hold location is required for QC hold events.' });
    }
    if (error?.message === 'QC_REJECT_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Reject location is required for QC reject events.' });
    }
    if (error?.message === 'IDEMPOTENCY_HASH_MISMATCH') {
      return res.status(409).json({ error: 'Idempotency key reused with a different request payload.' });
    }
    if (error?.message === 'QC_SOURCE_REQUIRED') {
      return res.status(400).json({ error: 'A valid source (receipt line, work order, or execution line) is required.' });
    }
    if (error?.code === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({
        error: { code: 'INSUFFICIENT_STOCK', message: error.details?.message, details: error.details }
      });
    }
    if (error?.code === 'DISCRETE_UOM_REQUIRES_INTEGER') {
      return res.status(400).json({
        error: {
          code: 'DISCRETE_UOM_REQUIRES_INTEGER',
          message: error.details?.message,
          details: error.details
        }
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
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Referenced source does not exist.' } }),
      check: () => ({ status: 400, body: { error: 'QC quantity must be greater than zero.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create QC event.' });
  }
});

router.get('/purchase-order-receipt-lines/:id/qc-events', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid receipt line id.' });
  }

  try {
    const events = await listQcEventsForLine(req.auth!.tenantId, id);
    return res.json({ data: events });
  } catch (error: any) {
    if (error?.message === 'QC_LINE_NOT_FOUND') {
      return res.status(404).json({ error: 'Receipt line not found.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to list QC events.' });
  }
});

router.get('/work-orders/:id/qc-events', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }

  try {
    const events = await listQcEventsForWorkOrder(req.auth!.tenantId, id);
    return res.json({ data: events });
  } catch (error: any) {
    if (error?.message === 'QC_WORK_ORDER_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to list QC events.' });
  }
});

router.get('/work-order-execution-lines/:id/qc-events', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid execution line id.' });
  }

  try {
    const events = await listQcEventsForExecutionLine(req.auth!.tenantId, id);
    return res.json({ data: events });
  } catch (error: any) {
    if (error?.message === 'QC_EXECUTION_LINE_NOT_FOUND') {
      return res.status(404).json({ error: 'Execution line not found.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to list QC events.' });
  }
});

router.get('/qc-events/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid QC event id.' });
  }

  try {
    const event = await getQcEventById(req.auth!.tenantId, id);
    if (!event) {
      return res.status(404).json({ error: 'QC event not found.' });
    }
    return res.json(event);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch QC event.' });
  }
});

export default router;
