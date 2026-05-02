import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { holdDispositionSchema, qcEventSchema, qcWarehouseDispositionSchema } from '../schemas/qc.schema';
import { 
  postQcWarehouseDisposition,
  createQcEvent, 
  getQcEventById, 
  listQcEventsForLine, 
  listQcEventsForWorkOrder, 
  listQcEventsForExecutionLine 
} from '../services/qc.service';
import { resolveHoldDisposition } from '../services/holdDisposition.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { getIdempotencyKey } from '../lib/idempotency';
import { mapTxRetryExhausted } from './shared/inventoryMutationConflicts';

const router = Router();
const uuidSchema = z.string().uuid();

function resolveRequestIdempotencyKey(req: Request, bodyKey?: string | null): string | null {
  const headerKey = getIdempotencyKey(req);
  const normalizedBody = bodyKey?.trim() ? bodyKey.trim() : null;
  return normalizedBody ?? headerKey;
}

router.post('/qc/accept', async (req: Request, res: Response) => {
  const parsed = qcWarehouseDispositionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const idempotencyKey = resolveRequestIdempotencyKey(req, parsed.data.idempotencyKey);

  try {
    const result = await postQcWarehouseDisposition(
      req.auth!.tenantId,
      'accept',
      parsed.data,
      { type: 'user', id: req.auth!.userId },
      { idempotencyKey }
    );
    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error: any) {
    if (mapTxRetryExhausted(error, res)) {
      return;
    }
    if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      return res.status(409).json({ error: 'QC accept already in progress for this idempotency key.' });
    }
    if (error?.code === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS') {
      return res.status(409).json({ error: 'Idempotency key was already used for a different endpoint.' });
    }
    if (error?.code === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD') {
      return res.status(409).json({ error: 'QC accept idempotency key was reused with a different payload.' });
    }
    if (error?.message === 'QC_WAREHOUSE_NOT_FOUND') {
      return res.status(404).json({ error: 'Warehouse not found.' });
    }
    if (error?.message === 'QC_QA_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'QA location is required for QC accept.' });
    }
    if (error?.message === 'QC_ACCEPT_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Sellable location is required for QC accept.' });
    }
    if (error?.message === 'QC_SOURCE_MUST_BE_QA') {
      return res.status(400).json({ error: 'QC accept must source from QA.' });
    }
    if (error?.message === 'QC_ACCEPT_REQUIRES_SELLABLE_ROLE' || error?.message === 'QC_ACCEPT_REQUIRES_SELLABLE_FLAG') {
      return res.status(400).json({ error: 'QC accept destination must be SELLABLE and sellable.' });
    }
    if (error?.code === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({
        error: { code: 'INSUFFICIENT_STOCK', message: error.details?.message, details: error.details }
      });
    }
    if (error?.code === 'NEGATIVE_OVERRIDE_NOT_ALLOWED') {
      return res.status(403).json({
        error: { code: 'NEGATIVE_OVERRIDE_NOT_ALLOWED', message: error.details?.message, details: error.details }
      });
    }
    if (error?.code === 'NEGATIVE_OVERRIDE_REQUIRES_REASON') {
      return res.status(409).json({
        error: { code: 'NEGATIVE_OVERRIDE_REQUIRES_REASON', message: error.details?.message, details: error.details }
      });
    }
    if (error?.message === 'TRANSFER_INSUFFICIENT_COST_LAYERS') {
      return res.status(409).json({
        error: 'Insufficient source cost layers for QC accept. Ensure receipt lines include unit cost/price before QC disposition.'
      });
    }
    if (error?.message?.startsWith('ITEM_CANONICAL_UOM') || error?.message?.startsWith('UOM_')) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post QC accept.' });
  }
});

router.post('/qc/reject', async (req: Request, res: Response) => {
  const parsed = qcWarehouseDispositionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const idempotencyKey = resolveRequestIdempotencyKey(req, parsed.data.idempotencyKey);

  try {
    const result = await postQcWarehouseDisposition(
      req.auth!.tenantId,
      'reject',
      parsed.data,
      { type: 'user', id: req.auth!.userId },
      { idempotencyKey }
    );
    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error: any) {
    if (mapTxRetryExhausted(error, res)) {
      return;
    }
    if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      return res.status(409).json({ error: 'QC reject already in progress for this idempotency key.' });
    }
    if (error?.code === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS') {
      return res.status(409).json({ error: 'Idempotency key was already used for a different endpoint.' });
    }
    if (error?.code === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD') {
      return res.status(409).json({ error: 'QC reject idempotency key was reused with a different payload.' });
    }
    if (error?.message === 'QC_WAREHOUSE_NOT_FOUND') {
      return res.status(404).json({ error: 'Warehouse not found.' });
    }
    if (error?.message === 'QC_QA_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'QA location is required for QC reject.' });
    }
    if (error?.message === 'QC_HOLD_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Hold location is required for QC reject.' });
    }
    if (error?.message === 'QC_SOURCE_MUST_BE_QA') {
      return res.status(400).json({ error: 'QC reject must source from QA.' });
    }
    if (error?.message === 'QC_HOLD_REQUIRES_HOLD_ROLE' || error?.message === 'QC_HOLD_MUST_NOT_BE_SELLABLE') {
      return res.status(400).json({ error: 'QC reject destination must be HOLD and non-sellable.' });
    }
    if (error?.code === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({
        error: { code: 'INSUFFICIENT_STOCK', message: error.details?.message, details: error.details }
      });
    }
    if (error?.code === 'NEGATIVE_OVERRIDE_NOT_ALLOWED') {
      return res.status(403).json({
        error: { code: 'NEGATIVE_OVERRIDE_NOT_ALLOWED', message: error.details?.message, details: error.details }
      });
    }
    if (error?.code === 'NEGATIVE_OVERRIDE_REQUIRES_REASON') {
      return res.status(409).json({
        error: { code: 'NEGATIVE_OVERRIDE_REQUIRES_REASON', message: error.details?.message, details: error.details }
      });
    }
    if (error?.message === 'TRANSFER_INSUFFICIENT_COST_LAYERS') {
      return res.status(409).json({
        error: 'Insufficient source cost layers for QC reject. Ensure receipt lines include unit cost/price before QC disposition.'
      });
    }
    if (error?.message?.startsWith('ITEM_CANONICAL_UOM') || error?.message?.startsWith('UOM_')) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post QC reject.' });
  }
});

router.post('/qc/hold-dispositions', async (req: Request, res: Response) => {
  const parsed = holdDispositionSchema.safeParse({
    ...req.body,
    actorType: 'user',
    actorId: req.auth!.userId
  });
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const idempotencyKey = resolveRequestIdempotencyKey(req, null);

  try {
    const result = await resolveHoldDisposition(req.auth!.tenantId, parsed.data, { idempotencyKey });
    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error: any) {
    if (mapTxRetryExhausted(error, res)) {
      return;
    }
    if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      return res.status(409).json({ error: 'Hold disposition already in progress for this idempotency key.' });
    }
    if (error?.code === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS') {
      return res.status(409).json({ error: 'Idempotency key was already used for a different endpoint.' });
    }
    if (error?.code === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD') {
      return res.status(409).json({ error: 'Hold disposition idempotency key was reused with a different payload.' });
    }
    if (error?.message === 'HOLD_DISPOSITION_LINE_NOT_FOUND') {
      return res.status(404).json({ error: 'Receipt line not found.' });
    }
    if (error?.message === 'HOLD_DISPOSITION_RECEIPT_VOIDED') {
      return res.status(409).json({ error: 'Receipt is voided; hold disposition is not allowed.' });
    }
    if (error?.message === 'HOLD_DISPOSITION_RECEIPT_NOT_ELIGIBLE') {
      return res.status(409).json({ error: 'Receipt is not eligible for hold disposition.' });
    }
    if (error?.message === 'HOLD_DISPOSITION_UOM_MISMATCH') {
      return res.status(400).json({ error: 'Hold disposition UOM must match the receipt line UOM.' });
    }
    if (error?.message === 'HOLD_DISPOSITION_EXCEEDS_HELD') {
      return res.status(400).json({ error: 'Hold disposition quantity exceeds remaining held quantity.' });
    }
    if (error?.message === 'HOLD_DISPOSITION_NO_HELD_QUANTITY') {
      return res.status(409).json({ error: 'No held quantity remains to resolve.' });
    }
    if (error?.message === 'HOLD_DISPOSITION_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Receipt line has no receiving location for hold disposition.' });
    }
    if (error?.message === 'HOLD_DISPOSITION_HOLD_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Hold disposition requires a HOLD source location.' });
    }
    if (error?.message === 'HOLD_DISPOSITION_SELLABLE_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Hold release requires a SELLABLE destination location.' });
    }
    if (error?.message === 'HOLD_DISPOSITION_REJECT_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Hold rework/discard requires a REJECT destination location.' });
    }
    if (error?.message === 'TRANSFER_INSUFFICIENT_COST_LAYERS') {
      return res.status(409).json({
        error: 'Hold disposition requires available FIFO cost layers at source. Ensure receipt lines include unit cost/price before resolving hold.'
      });
    }
    if (error?.code === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({
        error: { code: 'INSUFFICIENT_STOCK', message: error.details?.message, details: error.details }
      });
    }
    if (error?.code === 'REPLAY_CORRUPTION_DETECTED' || error?.message === 'REPLAY_CORRUPTION_DETECTED') {
      return res.status(409).json({
        error: {
          code: 'REPLAY_CORRUPTION_DETECTED',
          message: 'Replay repair detected corrupted authoritative hold disposition movement state.',
          details: error?.details
        }
      });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to resolve QC hold.' });
  }
});

router.post('/qc-events', async (req: Request, res: Response) => {
  const parsed = qcEventSchema.safeParse({
    ...req.body,
    actorType: 'user',
    actorId: req.auth!.userId
  });
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const idempotencyKey = getIdempotencyKey(req);

  try {
    const result = await createQcEvent(req.auth!.tenantId, parsed.data, { idempotencyKey });
    return res.status(result.replayed ? 200 : 201).json(result.event);
  } catch (error: any) {
    if (mapTxRetryExhausted(error, res)) {
      return;
    }
    if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      return res.status(409).json({ error: 'QC event already in progress for this key.' });
    }
    if (
      error?.code === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
      || error?.message === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
    ) {
      return res.status(409).json({ error: 'QC event idempotency key was reused with a different payload.' });
    }
    if (
      error?.code === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS'
      || error?.message === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS'
    ) {
      return res.status(409).json({ error: 'Idempotency key was already used for a different endpoint.' });
    }
    if (error?.code === 'REPLAY_CORRUPTION_DETECTED' || error?.message === 'REPLAY_CORRUPTION_DETECTED') {
      return res.status(409).json({
        error: {
          code: 'REPLAY_CORRUPTION_DETECTED',
          message: 'Replay repair detected corrupted authoritative QC transfer movement state.',
          details: error?.details
        }
      });
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
    if (error?.message === 'QC_QA_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'QA location is required for QC disposition.' });
    }
    if (error?.message === 'QC_TRANSFER_IN_PROGRESS') {
      return res.status(409).json({ error: 'QC transfer already in progress for this event.' });
    }
    if (error?.message === 'QC_SOURCE_MUST_BE_QA') {
      return res.status(400).json({ error: 'QC transfers must source from a QA location.' });
    }
    if (error?.message === 'QC_ACCEPT_REQUIRES_SELLABLE_ROLE') {
      return res.status(400).json({ error: 'QC accept requires a sellable destination.' });
    }
    if (error?.message === 'QC_ACCEPT_REQUIRES_SELLABLE_FLAG') {
      return res.status(400).json({ error: 'QC accept destination must be sellable.' });
    }
    if (error?.message === 'QC_HOLD_REQUIRES_HOLD_ROLE') {
      return res.status(400).json({ error: 'QC hold requires a hold destination.' });
    }
    if (error?.message === 'QC_HOLD_MUST_NOT_BE_SELLABLE') {
      return res.status(400).json({ error: 'QC hold destination must be non-sellable.' });
    }
    if (error?.message === 'QC_REJECT_REQUIRES_REJECT_ROLE') {
      return res.status(400).json({ error: 'QC reject requires a reject destination.' });
    }
    if (error?.message === 'QC_REJECT_MUST_NOT_BE_SELLABLE') {
      return res.status(400).json({ error: 'QC reject destination must be non-sellable.' });
    }
    if (error?.message === 'TRANSFER_DESTINATION_NOT_FOUND') {
      return res.status(400).json({ error: 'Destination location not found.' });
    }
    if (error?.message === 'TRANSFER_SOURCE_NOT_FOUND') {
      return res.status(400).json({ error: 'Source location not found.' });
    }
    if (error?.message === 'TRANSFER_INSUFFICIENT_COST_LAYERS') {
      return res.status(409).json({
        error: 'QC disposition requires available FIFO cost layers at source. Ensure receipt lines include unit cost/price before QC.'
      });
    }
    if (error?.message === 'QC_SOURCE_REQUIRED') {
      return res.status(400).json({ error: 'A valid source (receipt line, work order, or execution line) is required.' });
    }
    if (error?.message === 'QC_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'QC source location is required.' });
    }
    if (error?.message === 'QC_ITEM_ID_REQUIRED') {
      return res.status(400).json({ error: 'QC item is required.' });
    }
    if (error?.message === 'QC_ACTION_REQUIRED') {
      return res.status(400).json({ error: 'QC action is required.' });
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
