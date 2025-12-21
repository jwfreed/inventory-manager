import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import {
  drpGrossRequirementsCreateSchema,
  drpItemPoliciesCreateSchema,
  drpLaneSchema,
  drpNodeSchema,
  drpPeriodsCreateSchema,
  drpRunSchema,
} from '../schemas/drp.schema';
import {
  createDrpGrossRequirements,
  createDrpItemPolicies,
  createDrpLane,
  createDrpNode,
  createDrpPeriods,
  createDrpRun,
  getDrpLane,
  getDrpNode,
  getDrpRun,
  listDrpGrossRequirements,
  listDrpItemPolicies,
  listDrpLanes,
  listDrpNodes,
  listDrpPeriods,
  listDrpPlanLines,
  listDrpPlannedTransfers,
  listDrpRuns,
} from '../services/drp.service';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/drp/nodes', async (req: Request, res: Response) => {
  const parsed = drpNodeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const node = await createDrpNode(req.auth!.tenantId, parsed.data);
    return res.status(201).json(node);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Node code or location must be unique.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Location does not exist.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid node type.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create DRP node.' });
  }
});

router.get('/drp/nodes', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await listDrpNodes(req.auth!.tenantId, limit, offset);
  return res.json({ data, paging: { limit, offset } });
});

router.get('/drp/nodes/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid node id.' });
  const node = await getDrpNode(req.auth!.tenantId, id);
  if (!node) return res.status(404).json({ error: 'DRP node not found.' });
  return res.json(node);
});

router.post('/drp/lanes', async (req: Request, res: Response) => {
  const parsed = drpLaneSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const lane = await createDrpLane(req.auth!.tenantId, parsed.data);
    return res.status(201).json(lane);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Lane from/to pair must be unique.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'From or to node not found.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid lane configuration.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create DRP lane.' });
  }
});

router.get('/drp/lanes', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await listDrpLanes(req.auth!.tenantId, limit, offset);
  return res.json({ data, paging: { limit, offset } });
});

router.get('/drp/lanes/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid lane id.' });
  const lane = await getDrpLane(req.auth!.tenantId, id);
  if (!lane) return res.status(404).json({ error: 'DRP lane not found.' });
  return res.json(lane);
});

router.post('/drp/runs', async (req: Request, res: Response) => {
  const parsed = drpRunSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const run = await createDrpRun(req.auth!.tenantId, parsed.data);
    return res.status(201).json(run);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      check: () => ({ status: 400, body: { error: 'Invalid run status, bucket type, or date range.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create DRP run.' });
  }
});

router.get('/drp/runs', async (_req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(_req.query.limit) || 50));
  const offset = Math.max(0, Number(_req.query.offset) || 0);
  const data = await listDrpRuns(_req.auth!.tenantId, limit, offset);
  return res.json({ data, paging: { limit, offset } });
});

router.get('/drp/runs/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const run = await getDrpRun(req.auth!.tenantId, id);
  if (!run) return res.status(404).json({ error: 'DRP run not found.' });
  return res.json(run);
});

router.post('/drp/runs/:id/periods', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const parsed = drpPeriodsCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createDrpPeriods(req.auth!.tenantId, id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'DRP run not found.' });
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Duplicate period sequence or range for this run.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid period dates.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create DRP periods.' });
  }
});

router.get('/drp/runs/:id/periods', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const data = await listDrpPeriods(req.auth!.tenantId, id);
  return res.json({ data });
});

router.post('/drp/runs/:id/item-policies', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const parsed = drpItemPoliciesCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createDrpItemPolicies(req.auth!.tenantId, id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'DRP run not found.' });
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Duplicate policy scope for this run.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Invalid node or item reference.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid policy configuration.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create DRP item policies.' });
  }
});

router.get('/drp/runs/:id/item-policies', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const data = await listDrpItemPolicies(req.auth!.tenantId, id);
  return res.json({ data });
});

router.post('/drp/runs/:id/gross-requirements', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const parsed = drpGrossRequirementsCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createDrpGrossRequirements(req.auth!.tenantId, id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'DRP run not found.' });
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Invalid node or item reference.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid requirement type or quantity.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create DRP gross requirements.' });
  }
});

router.get('/drp/runs/:id/gross-requirements', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const data = await listDrpGrossRequirements(req.auth!.tenantId, id);
  return res.json({ data });
});

router.get('/drp/runs/:id/plan-lines', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const data = await listDrpPlanLines(req.auth!.tenantId, id);
  return res.json({ data });
});

router.get('/drp/runs/:id/planned-transfers', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const data = await listDrpPlannedTransfers(req.auth!.tenantId, id);
  return res.json({ data });
});

export default router;
