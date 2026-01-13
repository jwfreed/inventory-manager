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
  recordWorkOrderBatch
} from '../services/workOrderExecution.service';
import {
  workOrderCompletionCreateSchema,
  workOrderIssueCreateSchema,
  workOrderBatchSchema,
  workOrderIssuePostSchema
} from '../schemas/workOrderExecution.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';

const router = Router();
const uuidSchema = z.string().uuid();

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
    const issue = await createWorkOrderIssue(req.auth!.tenantId, workOrderId, parsed.data);
    return res.status(201).json(issue);
  } catch (error: any) {
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
    const completion = await createWorkOrderCompletion(req.auth!.tenantId, workOrderId, parsed.data);
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

export default router;
