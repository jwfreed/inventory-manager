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
  workOrderBatchSchema
} from '../schemas/workOrderExecution.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';

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
    const issue = await createWorkOrderIssue(workOrderId, parsed.data);
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
    const issue = await fetchWorkOrderIssue(workOrderId, issueId);
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

  try {
    const issue = await postWorkOrderIssue(workOrderId, issueId);
    return res.json(issue);
  } catch (error: any) {
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
    const completion = await createWorkOrderCompletion(workOrderId, parsed.data);
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
    const completion = await fetchWorkOrderCompletion(workOrderId, completionId);
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
    const completion = await postWorkOrderCompletion(workOrderId, completionId);
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
    const result = await recordWorkOrderBatch(workOrderId, parsed.data);
    return res.status(201).json(result);
  } catch (error: any) {
    if (error?.message === 'WO_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    if (error?.message === 'WO_INVALID_STATE') {
      return res.status(400).json({ error: 'Work order not in a state that allows recording a batch.' });
    }
    if (error?.message === 'WO_BATCH_ITEM_MISMATCH') {
      return res.status(400).json({ error: 'Output item mismatch with work order.' });
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
    const summary = await getWorkOrderExecutionSummary(workOrderId);
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
