import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createWorkOrderCompletion,
  createWorkOrderIssue,
  fetchWorkOrderCompletion,
  fetchWorkOrderIssue,
  getWorkOrderExecutionSummary,
  postWorkOrderCompletion,
  postWorkOrderIssue,
  recordWorkOrderBatch,
  reportWorkOrderProduction,
  reportWorkOrderScrap,
  voidWorkOrderProductionReport
} from '../services/workOrderExecution.service';
import {
  workOrderCompletionCreateSchema,
  workOrderIssueCreateSchema,
  workOrderBatchSchema,
  workOrderIssuePostSchema,
  workOrderReportProductionSchema,
  workOrderReportScrapSchema,
  workOrderVoidReportProductionSchema
} from '../schemas/workOrderExecution.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';
import { getIdempotencyKey } from '../lib/idempotency';
import { mapTxRetryExhausted, mapAtpConcurrencyExhausted, mapAtpInsufficientAvailable } from './orderToCash.shipmentConflicts';

const router = Router();
const uuidSchema = z.string().uuid();

function parseConservationDetails(detail: unknown) {
  if (typeof detail !== 'string' || detail.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(detail);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveRequestIdempotencyKey(req: Request, bodyKey?: string | null): string | null {
  const headerKey = getIdempotencyKey(req);
  const normalizedBody = bodyKey?.trim() ? bodyKey.trim() : null;
  return normalizedBody ?? headerKey;
}

router.post('/work-orders/:id/issues', async (req: Request, res: Response) => {
  const workOrderId = req.params.id;
  if (!uuidSchema.safeParse(workOrderId).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  const parsed = workOrderIssueCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const issue = await createWorkOrderIssue(req.auth!.tenantId, workOrderId, parsed.data, {
      idempotencyKey: getIdempotencyKey(req)
    });
    return res.status(201).json(issue);
  } catch (error: any) {
    if (error?.code === 'DISCRETE_UOM_REQUIRES_INTEGER') {
      return res.status(400).json({
        error: {
          code: 'DISCRETE_UOM_REQUIRES_INTEGER',
          message: error.details?.message,
          details: error.details
        }
      });
    }
    if (error?.message === 'WO_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    if (error?.message === 'WO_INVALID_STATE') {
      return res.status(400).json({ error: 'Work order is not in a state that allows issuing.' });
    }
    if (error?.message === 'WO_ISSUE_DUPLICATE_LINE') {
      return res.status(400).json({ error: 'Line numbers must be unique within an issue.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Referenced item or location does not exist.' } }),
      check: () => ({ status: 400, body: { error: 'Quantity issued must be greater than zero.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create work order issue.' });
  }
});

router.get('/work-orders/:id/issues/:issueId', async (req: Request, res: Response) => {
  const workOrderId = req.params.id;
  const issueId = req.params.issueId;
  if (!uuidSchema.safeParse(workOrderId).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  if (!uuidSchema.safeParse(issueId).success) {
    return res.status(400).json({ error: 'Invalid issue id.' });
  }
  try {
    const issue = await fetchWorkOrderIssue(req.auth!.tenantId, workOrderId, issueId);
    if (!issue) {
      return res.status(404).json({ error: 'Issue not found.' });
    }
    return res.json(issue);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch work order issue.' });
  }
});

router.post('/work-orders/:id/issues/:issueId/post', async (req: Request, res: Response) => {
  const workOrderId = req.params.id;
  const issueId = req.params.issueId;
  if (!uuidSchema.safeParse(workOrderId).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  if (!uuidSchema.safeParse(issueId).success) {
    return res.status(400).json({ error: 'Invalid issue id.' });
  }
  const parsed = workOrderIssuePostSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const tenantId = req.auth!.tenantId;
    const issue = await postWorkOrderIssue(tenantId, workOrderId, issueId, {
      actor: { type: 'user', id: req.auth!.userId, role: req.auth!.role },
      overrideRequested: parsed.data.overrideNegative,
      overrideReason: parsed.data.overrideReason
    });
    const itemIds = Array.from(new Set(issue.lines.map((line) => line.componentItemId)));
    const locationIds = Array.from(new Set(issue.lines.map((line) => line.fromLocationId)));
    emitEvent(tenantId, 'inventory.work_order.issue.posted', {
      workOrderId,
      issueId,
      movementId: issue.inventoryMovementId,
      itemIds,
      locationIds
    });
    return res.json(issue);
  } catch (error: any) {
    if (mapTxRetryExhausted(error, res)) {
      return;
    }
    if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS' || error?.message === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      return res.status(409).json({
        error: {
          code: 'WO_POSTING_IDEMPOTENCY_INCOMPLETE',
          message: 'Work-order production report is already in progress for this idempotency key.',
          details: error?.details
        }
      });
    }
    if (
      error?.code === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
      || error?.message === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
      || error?.code === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS'
      || error?.message === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS'
    ) {
      return res.status(409).json({
        error: {
          code: 'WO_POSTING_IDEMPOTENCY_CONFLICT',
          message: 'Idempotency key payload conflict detected for report-production.',
          details: error?.details
        }
      });
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
    if (error?.message === 'WO_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    if (error?.message === 'WO_INVALID_STATE') {
      return res.status(400).json({ error: 'Work order is not in a state that allows issuing.' });
    }
    if (error?.message === 'WO_ISSUE_NOT_FOUND') {
      return res.status(404).json({ error: 'Issue not found.' });
    }
    if (error?.message === 'WO_ISSUE_ALREADY_POSTED') {
      return res.status(409).json({ error: 'Issue already posted.' });
    }
    if (error?.message === 'WO_ISSUE_CANCELED') {
      return res.status(400).json({ error: 'Canceled issues cannot be posted.' });
    }
    if (error?.message === 'WO_ISSUE_NO_LINES') {
      return res.status(400).json({ error: 'Issue has no lines to post.' });
    }
    if (error?.message === 'WO_ISSUE_INVALID_QUANTITY') {
      return res.status(400).json({ error: 'Issue quantities must be greater than zero.' });
    }
    if (error?.message === 'WO_DISASSEMBLY_INPUT_MISMATCH') {
      return res.status(400).json({ error: 'Disassembly issues must consume the selected item.' });
    }
    if (error?.message === 'WO_WIP_COST_LAYERS_MISSING') {
      return res.status(409).json({ error: 'FIFO cost layers required to post work order issues.' });
    }
    if (
      error?.message === 'WO_POSTING_MOVEMENT_MISSING' ||
      error?.message === 'WO_POSTING_IDEMPOTENCY_CONFLICT' ||
      error?.message === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE'
    ) {
      return res.status(409).json({ error: 'Posting idempotency conflict detected. Retry safely.' });
    }
    if (error?.message?.startsWith('ITEM_CANONICAL_UOM') || error?.message?.startsWith('UOM_')) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post work order issue.' });
  }
});

router.post('/work-orders/:id/completions', async (req: Request, res: Response) => {
  const workOrderId = req.params.id;
  if (!uuidSchema.safeParse(workOrderId).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  const parsed = workOrderCompletionCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const completion = await createWorkOrderCompletion(req.auth!.tenantId, workOrderId, parsed.data, {
      idempotencyKey: getIdempotencyKey(req)
    });
    return res.status(201).json(completion);
  } catch (error: any) {
    if (error?.message === 'WO_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    if (error?.message === 'WO_INVALID_STATE') {
      return res.status(400).json({ error: 'Work order is not in a state that allows completion.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Referenced item or location does not exist.' } }),
      check: () => ({ status: 400, body: { error: 'Quantity completed must be greater than zero.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create work order completion.' });
  }
});

router.get('/work-orders/:id/completions/:completionId', async (req: Request, res: Response) => {
  const workOrderId = req.params.id;
  const completionId = req.params.completionId;
  if (!uuidSchema.safeParse(workOrderId).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  if (!uuidSchema.safeParse(completionId).success) {
    return res.status(400).json({ error: 'Invalid completion id.' });
  }
  try {
    const completion = await fetchWorkOrderCompletion(req.auth!.tenantId, workOrderId, completionId);
    if (!completion) {
      return res.status(404).json({ error: 'Completion not found.' });
    }
    return res.json(completion);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch work order completion.' });
  }
});

router.post('/work-orders/:id/completions/:completionId/post', async (req: Request, res: Response) => {
  const workOrderId = req.params.id;
  const completionId = req.params.completionId;
  if (!uuidSchema.safeParse(workOrderId).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  if (!uuidSchema.safeParse(completionId).success) {
    return res.status(400).json({ error: 'Invalid completion id.' });
  }

  try {
    const tenantId = req.auth!.tenantId;
    const completion = await postWorkOrderCompletion(tenantId, workOrderId, completionId);
    const itemIds = Array.from(new Set(completion.lines.map((line) => line.itemId)));
    const locationIds = Array.from(new Set(completion.lines.map((line) => line.toLocationId)));
    emitEvent(tenantId, 'inventory.work_order.completion.posted', {
      workOrderId,
      completionId,
      movementId: completion.productionMovementId,
      itemIds,
      locationIds
    });
    // Additional event for dashboard real-time updates
    emitEvent(tenantId, 'workorder:completed', {
      workOrderId,
      completionId,
      status: completion.status
    });
    return res.json(completion);
  } catch (error: any) {
    if (mapTxRetryExhausted(error, res)) {
      return;
    }
    if (error?.message === 'WO_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    if (error?.message === 'WO_INVALID_STATE') {
      return res.status(400).json({ error: 'Work order is not in a state that allows completion.' });
    }
    if (error?.message === 'WO_COMPLETION_NOT_FOUND') {
      return res.status(404).json({ error: 'Completion not found.' });
    }
    if (error?.message === 'WO_COMPLETION_ALREADY_POSTED') {
      return res.status(409).json({ error: 'Completion already posted.' });
    }
    if (error?.message === 'WO_COMPLETION_CANCELED') {
      return res.status(400).json({ error: 'Canceled completions cannot be posted.' });
    }
    if (error?.message === 'WO_COMPLETION_NO_LINES') {
      return res.status(400).json({ error: 'Completion has no lines to post.' });
    }
    if (error?.message === 'WO_COMPLETION_ITEM_MISMATCH') {
      return res.status(400).json({ error: 'Completion item must match the work order output item.' });
    }
    if (error?.message === 'WO_COMPLETION_INVALID_LINE_TYPE') {
      return res.status(400).json({ error: 'Completion contains invalid line type.' });
    }
    if (error?.message === 'WO_COMPLETION_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Completion lines must include a toLocationId.' });
    }
    if (error?.message === 'WO_COMPLETION_INVALID_QUANTITY') {
      return res.status(400).json({ error: 'Completion quantities must be greater than zero.' });
    }
    if (error?.message === 'WO_WIP_COST_NO_CONSUMPTIONS') {
      return res.status(409).json({ error: 'No unallocated issue costs available for WIP valuation.' });
    }
    if (error?.message === 'WO_WIP_COST_INVALID_OUTPUT_QTY') {
      return res.status(400).json({ error: 'Completion quantities could not be canonicalized for WIP valuation.' });
    }
    if (
      error?.message === 'WO_POSTING_MOVEMENT_MISSING' ||
      error?.message === 'WO_POSTING_IDEMPOTENCY_CONFLICT' ||
      error?.message === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE'
    ) {
      return res.status(409).json({ error: 'Posting idempotency conflict detected. Retry safely.' });
    }
    if (error?.message === 'WORK_ORDER_COST_CONSERVATION_FAILED') {
      return res.status(409).json({
        error: {
          code: 'WORK_ORDER_COST_CONSERVATION_FAILED',
          message: 'Work order posting failed cost conservation checks.',
          details: parseConservationDetails(error?.detail)
        }
      });
    }
    if (error?.message?.startsWith('ITEM_CANONICAL_UOM') || error?.message?.startsWith('UOM_')) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post work order completion.' });
  }
});

router.post('/work-orders/:id/record-batch', async (req: Request, res: Response) => {
  const workOrderId = req.params.id;
  if (!uuidSchema.safeParse(workOrderId).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  const parsed = workOrderBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const sentItemIds = Array.from(
    new Set([
      ...parsed.data.consumeLines.map((l) => l.componentItemId),
      ...parsed.data.produceLines.map((l) => l.outputItemId)
    ])
  );
  const sentLocationIds = Array.from(
    new Set([
      ...parsed.data.consumeLines.map((l) => l.fromLocationId),
      ...parsed.data.produceLines.map((l) => l.toLocationId)
    ])
  );

  try {
    const tenantId = req.auth!.tenantId;
    const result = await recordWorkOrderBatch(tenantId, workOrderId, parsed.data, {
      actor: { type: 'user', id: req.auth!.userId, role: req.auth!.role },
      overrideRequested: parsed.data.overrideNegative,
      overrideReason: parsed.data.overrideReason
    }, {
      idempotencyKey: getIdempotencyKey(req)
    });
    const itemIds = Array.from(
      new Set([
        ...parsed.data.consumeLines.map((line) => line.componentItemId),
        ...parsed.data.produceLines.map((line) => line.outputItemId)
      ])
    );
    const locationIds = Array.from(
      new Set([
        ...parsed.data.consumeLines.map((line) => line.fromLocationId),
        ...parsed.data.produceLines.map((line) => line.toLocationId)
      ])
    );
    emitEvent(tenantId, 'inventory.work_order.batch.posted', {
      workOrderId,
      issueMovementId: result.issueMovementId,
      receiveMovementId: result.receiveMovementId,
      itemIds,
      locationIds
    });
    // Additional event for dashboard real-time updates
    emitEvent(tenantId, 'workorder:completed', {
      workOrderId,
      status: result.workOrderStatus
    });
    emitEvent(tenantId, 'production:changed', {
      workOrderId,
      quantityCompleted: result.quantityCompleted
    });
    return res.status(201).json(result);
  } catch (error: any) {
    if (mapTxRetryExhausted(error, res)) {
      return;
    }
    if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS' || error?.message === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      return res.status(409).json({
        error: {
          code: 'WO_POSTING_IDEMPOTENCY_INCOMPLETE',
          message: 'Work-order batch posting is already in progress for this idempotency key.',
          details: error?.details
        }
      });
    }
    if (
      error?.code === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
      || error?.message === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
      || error?.code === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS'
      || error?.message === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS'
    ) {
      return res.status(409).json({
        error: {
          code: 'WO_POSTING_IDEMPOTENCY_CONFLICT',
          message: 'Idempotency key payload conflict detected for work-order batch posting.',
          details: error?.details
        }
      });
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
    if (error?.code === 'MANUFACTURING_CONSUMPTION_MUST_BE_SELLABLE' || error?.message === 'MANUFACTURING_CONSUMPTION_MUST_BE_SELLABLE') {
      return res.status(409).json({
        error: {
          code: 'MANUFACTURING_CONSUMPTION_MUST_BE_SELLABLE',
          message: 'Manufacturing backflush consumption must source from a sellable location.',
          details: error?.details
        }
      });
    }
    if (error?.message === 'WO_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    if (error?.message === 'WO_INVALID_STATE') {
      return res.status(400).json({ error: 'Work order not in a state that allows recording a batch.' });
    }
    if (error?.message === 'WO_BATCH_ITEM_MISMATCH') {
      return res.status(400).json({ error: 'Output item mismatch with work order.' });
    }
    if (error?.message === 'WO_DISASSEMBLY_INPUT_MISMATCH') {
      return res.status(400).json({ error: 'Disassembly consumption must match the selected item.' });
    }
    if (error?.message?.startsWith('WO_BATCH_ITEMS_MISSING')) {
      const missing = error.message.split(':')[1] ?? '';
      return res.status(400).json({ error: 'Items not found.', details: missing });
    }
    if (error?.message?.startsWith('WO_BATCH_LOCATIONS_MISSING')) {
      const missing = error.message.split(':')[1] ?? '';
      return res.status(400).json({ error: 'Locations not found.', details: missing });
    }
    if (error?.message?.startsWith('WO_BATCH_LOCATION_WAREHOUSE_MISSING')) {
      const missing = error.message.split(':')[1] ?? '';
      return res.status(409).json({ error: 'Location warehouse resolution failed.', details: missing });
    }
    if (error?.message?.startsWith('WO_BATCH_INVALID')) {
      return res.status(400).json({ error: 'Quantities must be greater than zero.' });
    }
    if (error?.message === 'WO_WIP_COST_LAYERS_MISSING') {
      return res.status(409).json({ error: 'FIFO cost layers required to record work order batch.' });
    }
    if (error?.message === 'WO_WIP_COST_NO_CONSUMPTIONS') {
      return res.status(409).json({ error: 'No issue costs available for WIP valuation.' });
    }
    if (error?.message === 'WO_WIP_COST_INVALID_OUTPUT_QTY') {
      return res.status(400).json({ error: 'Produced quantities could not be canonicalized for WIP valuation.' });
    }
    if (
      error?.message === 'WO_POSTING_MOVEMENT_MISSING' ||
      error?.message === 'WO_POSTING_IDEMPOTENCY_CONFLICT' ||
      error?.message === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE' ||
      error?.code === 'WO_POSTING_IDEMPOTENCY_CONFLICT' ||
      error?.code === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE'
    ) {
      const code =
        error?.code === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE' || error?.message === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE'
          ? 'WO_POSTING_IDEMPOTENCY_INCOMPLETE'
          : 'WO_POSTING_IDEMPOTENCY_CONFLICT';
      return res.status(409).json({
        error: {
          code,
          message:
            code === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE'
              ? 'Work-order batch posting is incomplete for this idempotency key.'
              : 'Idempotency key payload conflict detected for work-order batch posting.',
          details: error?.details
        }
      });
    }
    if (error?.message === 'WORK_ORDER_COST_CONSERVATION_FAILED') {
      return res.status(409).json({
        error: {
          code: 'WORK_ORDER_COST_CONSERVATION_FAILED',
          message: 'Work order posting failed cost conservation checks.',
          details: parseConservationDetails(error?.detail)
        }
      });
    }
    if (error?.message?.startsWith('ITEM_CANONICAL_UOM') || error?.message?.startsWith('UOM_')) {
      return res.status(400).json({ error: error.message });
    }
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({
        status: 400,
        body: {
          error: 'Referenced items or locations do not exist.',
          details: { items: sentItemIds, locations: sentLocationIds, constraint: error?.constraint, detail: error?.detail }
        }
      }),
      check: () => ({ status: 400, body: { error: 'Invalid quantities.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to record batch.', details: error?.message ?? error });
  }
});

router.post('/work-orders/:id/report-production', async (req: Request, res: Response) => {
  const workOrderId = req.params.id;
  if (!uuidSchema.safeParse(workOrderId).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  const parsed = workOrderReportProductionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const idempotencyKey = resolveRequestIdempotencyKey(req, parsed.data.idempotencyKey);

  try {
    const result = await reportWorkOrderProduction(
      req.auth!.tenantId,
      workOrderId,
      parsed.data,
      {
        actor: {
          type: 'user',
          id: req.auth!.userId,
          role: req.auth!.role
        }
      },
      { idempotencyKey }
    );
    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error: any) {
    if (mapTxRetryExhausted(error, res)) {
      return;
    }
    if (mapAtpConcurrencyExhausted(error, res)) {
      return;
    }
    if (mapAtpInsufficientAvailable(error, res)) {
      return;
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
    if (error?.code === 'MANUFACTURING_CONSUMPTION_MUST_BE_SELLABLE' || error?.message === 'MANUFACTURING_CONSUMPTION_MUST_BE_SELLABLE') {
      return res.status(409).json({
        error: {
          code: 'MANUFACTURING_CONSUMPTION_MUST_BE_SELLABLE',
          message: 'Manufacturing backflush consumption must source from a sellable location.',
          details: error?.details
        }
      });
    }
    if (error?.message === 'WO_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    if (error?.message === 'WO_INVALID_STATE') {
      return res.status(400).json({ error: 'Work order not in a state that allows production reporting.' });
    }
    if (error?.message === 'WO_REPORT_KIND_UNSUPPORTED') {
      return res.status(400).json({ error: 'Only production work orders support report-production.' });
    }
    if (error?.message === 'WO_REPORT_OUTPUT_UOM_MISMATCH') {
      return res.status(400).json({ error: 'Output UOM must match the work order output UOM.' });
    }
    if (error?.message === 'WO_REPORT_WAREHOUSE_REQUIRED') {
      return res.status(400).json({ error: 'warehouseId is required when work order defaults cannot resolve a warehouse.' });
    }
    if (error?.message === 'WO_REPORT_DEFAULT_LOCATIONS_REQUIRED') {
      return res.status(409).json({ error: 'Warehouse must have SELLABLE and QA defaults before reporting production.' });
    }
    if (error?.message?.startsWith('WO_BATCH_LOCATION_WAREHOUSE_MISSING')) {
      const missing = error.message.split(':')[1] ?? '';
      return res.status(409).json({ error: 'Location warehouse resolution failed.', details: missing });
    }
    if (error?.message === 'WO_BOM_NO_LINES') {
      return res.status(409).json({ error: 'BOM has no component lines for report-production.' });
    }
    if (error?.message === 'WO_REPORT_NO_COMPONENT_CONSUMPTION') {
      return res.status(400).json({ error: 'report-production requires at least one component consumption line.' });
    }
    if (error?.message === 'WO_REPORT_SCRAP_NOT_SUPPORTED') {
      return res.status(400).json({ error: 'scrapOutputs is not supported in report-production; use POST /work-orders/:id/report-scrap.' });
    }
    if (error?.message === 'WO_REPORT_OVERRIDE_DUPLICATE_COMPONENT') {
      return res.status(400).json({ error: 'consumptionOverrides cannot include duplicate componentItemId values.' });
    }
    if (
      error?.message === 'WO_POSTING_MOVEMENT_MISSING' ||
      error?.message === 'WO_POSTING_IDEMPOTENCY_CONFLICT' ||
      error?.message === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE' ||
      error?.code === 'WO_POSTING_IDEMPOTENCY_CONFLICT' ||
      error?.code === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE'
    ) {
      const code =
        error?.code === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE' || error?.message === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE'
          ? 'WO_POSTING_IDEMPOTENCY_INCOMPLETE'
          : 'WO_POSTING_IDEMPOTENCY_CONFLICT';
      return res.status(409).json({
        error: {
          code,
          message:
            code === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE'
              ? 'Work-order production report is incomplete for this idempotency key.'
              : 'Idempotency key payload conflict detected for report-production.',
          details: error?.details
        }
      });
    }
    if (error?.message === 'WORK_ORDER_COST_CONSERVATION_FAILED') {
      return res.status(409).json({
        error: {
          code: 'WORK_ORDER_COST_CONSERVATION_FAILED',
          message: 'Work order posting failed cost conservation checks.',
          details: parseConservationDetails(error?.detail)
        }
      });
    }
    if (error?.message?.startsWith('ITEM_CANONICAL_UOM') || error?.message?.startsWith('UOM_')) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to report work order production.' });
  }
});

router.post('/work-orders/:id/void-report-production', async (req: Request, res: Response) => {
  const workOrderId = req.params.id;
  if (!uuidSchema.safeParse(workOrderId).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  const parsed = workOrderVoidReportProductionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const idempotencyKey = resolveRequestIdempotencyKey(req, parsed.data.idempotencyKey);
  if (!idempotencyKey) {
    return res.status(400).json({
      error: {
        code: 'WO_VOID_IDEMPOTENCY_REQUIRED',
        message: 'Idempotency-Key header (or body idempotencyKey) is required for void-report-production.'
      }
    });
  }
  const tenantId = req.auth!.tenantId;

  try {
    const result = await voidWorkOrderProductionReport(
      tenantId,
      workOrderId,
      parsed.data,
      {
        type: 'user',
        id: req.auth!.userId
      },
      { idempotencyKey }
    );
    return res.status(result.replayed ? 200 : 201).json({
      ...result,
      idempotencyKey
    });
  } catch (error: any) {
    if (mapTxRetryExhausted(error, res)) {
      return;
    }
    if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS' || error?.message === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      return res.status(409).json({
        error: {
          code: 'WO_VOID_IN_PROGRESS',
          message: 'Void report-production is already in progress for this idempotency key.'
        }
      });
    }
    if (
      error?.code === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
      || error?.message === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
      || error?.message === 'IDEMPOTENCY_HASH_MISMATCH'
      || error?.code === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS'
      || error?.message === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS'
    ) {
      return res.status(409).json({
        error: {
          code: 'WO_VOID_IDEMPOTENCY_MISMATCH',
          message: 'Idempotency key reused with a different void-report-production request payload.'
        }
      });
    }
    if (error?.message === 'WO_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    if (error?.message === 'WO_VOID_EXECUTION_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order execution not found for this work order.' });
    }
    if (error?.message === 'WO_VOID_EXECUTION_NOT_POSTED') {
      return res.status(409).json({ error: 'Only posted production reports can be voided.' });
    }
    if (error?.message === 'WO_VOID_EXECUTION_MOVEMENTS_MISSING' || error?.message === 'WO_VOID_EXECUTION_MOVEMENT_TYPE_INVALID') {
      return res.status(409).json({ error: 'Work order execution does not have a valid posted production movement pair.' });
    }
    if (error?.message === 'WO_VOID_REASON_REQUIRED') {
      return res.status(400).json({ error: 'Void reason is required.' });
    }
    if (error?.message === 'WO_VOID_OUTPUT_NOT_QA') {
      return res.status(409).json({ error: 'Void is only allowed while produced output remains in QA.' });
    }
    if (error?.message === 'WO_VOID_PRODUCTION_LAYER_MISSING') {
      return res.status(409).json({ error: 'Production cost layers for this execution were not found.' });
    }
    if (error?.code === 'WO_VOID_OUTPUT_ALREADY_MOVED') {
      return res.status(409).json({
        error: {
          code: 'WO_VOID_OUTPUT_ALREADY_MOVED',
          message: 'Cannot void report-production after output has moved out of QA.',
          details: error?.details
        }
      });
    }
    if (error?.message?.startsWith('WO_VOID_LOCATION_WAREHOUSE_MISSING')) {
      const missing = error.message.split(':')[1] ?? '';
      return res.status(409).json({
        error: {
          code: 'WO_VOID_LOCATION_WAREHOUSE_MISSING',
          message: 'Warehouse resolution failed for one or more void movement locations.',
          details: missing
        }
      });
    }
    if (error?.message === 'WO_VOID_INCOMPLETE') {
      return res.status(409).json({ error: 'Void movements are present but incomplete. Retry with the same idempotency key.' });
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
    if (error?.message?.startsWith('ITEM_CANONICAL_UOM') || error?.message?.startsWith('UOM_')) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to void report-production.' });
  }
});

router.post('/work-orders/:id/report-scrap', async (req: Request, res: Response) => {
  const workOrderId = req.params.id;
  if (!uuidSchema.safeParse(workOrderId).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  const parsed = workOrderReportScrapSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const idempotencyKey = resolveRequestIdempotencyKey(req, parsed.data.idempotencyKey);

  try {
    const result = await reportWorkOrderScrap(
      req.auth!.tenantId,
      workOrderId,
      parsed.data,
      {
        type: 'user',
        id: req.auth!.userId
      },
      { idempotencyKey }
    );
    return res.status(result.replayed ? 200 : 201).json({
      ...result,
      idempotencyKey
    });
  } catch (error: any) {
    if (mapTxRetryExhausted(error, res)) {
      return;
    }
    if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS' || error?.message === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      return res.status(409).json({
        error: {
          code: 'WO_SCRAP_IN_PROGRESS',
          message: 'Work-order scrap posting is already in progress for this idempotency key.',
          details: error?.details
        }
      });
    }
    if (
      error?.code === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
      || error?.message === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
      || error?.code === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS'
      || error?.message === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS'
    ) {
      return res.status(409).json({
        error: {
          code: 'WO_SCRAP_IDEMPOTENCY_MISMATCH',
          message: 'Idempotency key reused with a different report-scrap payload.',
          details: error?.details
        }
      });
    }
    if (error?.message === 'WO_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    if (error?.message === 'WO_SCRAP_EXECUTION_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order execution not found for this work order.' });
    }
    if (error?.message === 'WO_SCRAP_EXECUTION_NOT_POSTED') {
      return res.status(409).json({ error: 'Only posted production reports support scrap posting.' });
    }
    if (error?.message === 'WO_SCRAP_OUTPUT_ITEM_MISMATCH') {
      return res.status(400).json({ error: 'outputItemId must match the work order output item.' });
    }
    if (error?.message === 'WO_SCRAP_QA_SOURCE_AMBIGUOUS') {
      return res.status(409).json({ error: 'Could not resolve a unique QA source location for this execution.' });
    }
    if (error?.message === 'WO_SCRAP_QA_SOURCE_WAREHOUSE_MISSING') {
      return res.status(409).json({ error: 'QA source location is missing a warehouse binding.' });
    }
    if (error?.message === 'WO_SCRAP_LOCATION_REQUIRED') {
      return res.status(409).json({ error: 'Warehouse must have a SCRAP default location before posting work-order scrap.' });
    }
    if (error?.message === 'WO_SCRAP_REASON_REQUIRED') {
      return res.status(400).json({ error: 'reasonCode is required for report-scrap.' });
    }
    if (error?.message === 'WO_SCRAP_INVALID_OCCURRED_AT') {
      return res.status(400).json({ error: 'Invalid occurredAt value.' });
    }
    if (error?.message === 'WO_SCRAP_INVALID_QTY') {
      return res.status(400).json({ error: 'quantity must be greater than zero.' });
    }
    if (error?.code === 'WO_SCRAP_EXCEEDS_EXECUTION_QA_AVAILABLE') {
      return res.status(409).json({
        error: {
          code: 'WO_SCRAP_EXCEEDS_EXECUTION_QA_AVAILABLE',
          message: 'Requested scrap quantity exceeds remaining QA inventory for this production execution.',
          details: error?.details
        }
      });
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
    if (error?.message?.startsWith('ITEM_CANONICAL_UOM') || error?.message?.startsWith('UOM_')) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post work-order scrap.' });
  }
});

router.get('/work-orders/:id/execution', async (req: Request, res: Response) => {
  const workOrderId = req.params.id;
  if (!uuidSchema.safeParse(workOrderId).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }

  try {
    const summary = await getWorkOrderExecutionSummary(req.auth!.tenantId, workOrderId);
    if (!summary) {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    return res.json(summary);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load work order execution summary.' });
  }
});

router.post('/work-orders/:id/reverse', async (req: Request, res: Response) => {
  const workOrderId = req.params.id;
  if (!uuidSchema.safeParse(workOrderId).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  return res.status(409).json({
    error: {
      code: 'WORK_ORDER_REVERSAL_NOT_SUPPORTED',
      message: 'Work order reversal is not supported. Post compensating movements instead.'
    }
  });
});

export default router;
