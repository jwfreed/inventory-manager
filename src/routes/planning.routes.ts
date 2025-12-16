import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import {
  kpiRollupInputsCreateSchema,
  kpiRunSchema,
  kpiSnapshotsCreateSchema,
  mpsDemandInputsCreateSchema,
  mpsPeriodsCreateSchema,
  mpsPlanSchema,
  mrpGrossRequirementsCreateSchema,
  mrpItemPoliciesCreateSchema,
  mrpRunSchema,
  replenishmentPolicySchema,
} from '../schemas/planning.schema';
import {
  createKpiRollupInputs,
  createKpiRun,
  createKpiSnapshots,
  createMpsDemandInputs,
  createMpsPeriods,
  createMpsPlan,
  createMrpGrossRequirements,
  createMrpItemPolicies,
  createMrpRun,
  createReplenishmentPolicy,
  getKpiRun,
  getMpsPlan,
  getMrpRun,
  getReplenishmentPolicy,
  listKpiRollupInputs,
  listKpiRunSnapshots,
  listKpiRuns,
  listKpiSnapshots,
  listMpsDemandInputs,
  listMpsPeriods,
  listMpsPlanLines,
  listMpsPlans,
  listMrpGrossRequirements,
  listMrpItemPolicies,
  listMrpPlanLines,
  listMrpPlannedOrders,
  listMrpRuns,
  listReplenishmentPolicies,
  listReplenishmentRecommendations,
} from '../services/planning.service';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/mps/plans', async (req: Request, res: Response) => {
  const parsed = mpsPlanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const plan = await createMpsPlan(parsed.data);
    return res.status(201).json(plan);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'MPS plan code must be unique.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid status, bucket type, or date range.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create MPS plan.' });
  }
});

router.get('/mps/plans', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await listMpsPlans(limit, offset);
  return res.json({ data, paging: { limit, offset } });
});

router.get('/mps/plans/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid plan id.' });
  const plan = await getMpsPlan(id);
  if (!plan) return res.status(404).json({ error: 'MPS plan not found.' });
  return res.json(plan);
});

router.post('/mps/plans/:id/periods', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid plan id.' });
  const parsed = mpsPeriodsCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const periods = await createMpsPeriods(id, parsed.data);
    return res.status(201).json({ data: periods });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'MPS plan not found.' });
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Duplicate period sequence or range for this plan.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid period date range.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create MPS periods.' });
  }
});

router.get('/mps/plans/:id/periods', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid plan id.' });
  const data = await listMpsPeriods(id);
  return res.json({ data });
});

router.post('/mps/plans/:id/demand-inputs', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid plan id.' });
  const parsed = mpsDemandInputsCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createMpsDemandInputs(id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'MPS plan not found.' });
    if (error?.code === 'BAD_REQUEST') return res.status(400).json({ error: 'mpsPlanItemId does not belong to this plan.' });
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Duplicate demand input for plan item + period + demand type.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Invalid plan item or period reference.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid demand type or quantity.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create MPS demand inputs.' });
  }
});

router.get('/mps/plans/:id/demand-inputs', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid plan id.' });
  const data = await listMpsDemandInputs(id);
  return res.json({ data });
});

router.get('/mps/plans/:id/plan-lines', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid plan id.' });
  const data = await listMpsPlanLines(id);
  return res.json({ data });
});

router.post('/mrp/runs', async (req: Request, res: Response) => {
  const parsed = mrpRunSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const run = await createMrpRun(parsed.data);
    return res.status(201).json(run);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Referenced MPS plan not found.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid status or bucket type.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create MRP run.' });
  }
});

router.get('/mrp/runs', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await listMrpRuns(limit, offset);
  return res.json({ data, paging: { limit, offset } });
});

router.get('/mrp/runs/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const run = await getMrpRun(id);
  if (!run) return res.status(404).json({ error: 'MRP run not found.' });
  return res.json(run);
});

router.post('/mrp/runs/:id/item-policies', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const parsed = mrpItemPoliciesCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createMrpItemPolicies(id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'MRP run not found.' });
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Duplicate policy scope for this run.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Invalid item or location reference.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid policy settings.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create MRP item policies.' });
  }
});

router.get('/mrp/runs/:id/item-policies', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const data = await listMrpItemPolicies(id);
  return res.json({ data });
});

router.post('/mrp/runs/:id/gross-requirements', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const parsed = mrpGrossRequirementsCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createMrpGrossRequirements(id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'MRP run not found.' });
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Invalid item or location reference.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid source type or quantity.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create MRP gross requirements.' });
  }
});

router.get('/mrp/runs/:id/gross-requirements', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const data = await listMrpGrossRequirements(id);
  return res.json({ data });
});

router.get('/mrp/runs/:id/plan-lines', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const data = await listMrpPlanLines(id);
  return res.json({ data });
});

router.get('/mrp/runs/:id/planned-orders', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid run id.' });
  const data = await listMrpPlannedOrders(id);
  return res.json({ data });
});

router.post('/replenishment/policies', async (req: Request, res: Response) => {
  const parsed = replenishmentPolicySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const policy = await createReplenishmentPolicy(parsed.data);
    return res.status(201).json(policy);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Duplicate replenishment policy scope.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Invalid item or location reference.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid replenishment policy fields.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create replenishment policy.' });
  }
});

router.get('/replenishment/policies', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await listReplenishmentPolicies(limit, offset);
  return res.json({ data, paging: { limit, offset } });
});

router.get('/replenishment/policies/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid policy id.' });
  const policy = await getReplenishmentPolicy(id);
  if (!policy) return res.status(404).json({ error: 'Replenishment policy not found.' });
  return res.json(policy);
});

router.get('/replenishment/recommendations', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await listReplenishmentRecommendations(limit, offset);
  return res.json({ data, paging: { limit, offset } });
});

router.post('/kpis/runs', async (req: Request, res: Response) => {
  const parsed = kpiRunSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const run = await createKpiRun(parsed.data);
    return res.status(201).json(run);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      check: () => ({ status: 400, body: { error: 'Invalid KPI run status.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create KPI run.' });
  }
});

router.get('/kpis/runs', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await listKpiRuns(limit, offset);
  return res.json({ data, paging: { limit, offset } });
});

router.get('/kpis/runs/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid KPI run id.' });
  const run = await getKpiRun(id);
  if (!run) return res.status(404).json({ error: 'KPI run not found.' });
  return res.json(run);
});

router.post('/kpis/runs/:id/snapshots', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid KPI run id.' });
  const parsed = kpiSnapshotsCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createKpiSnapshots(id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'KPI run not found.' });
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Invalid KPI run reference.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create KPI snapshots.' });
  }
});

router.get('/kpis/runs/:id/snapshots', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid KPI run id.' });
  const data = await listKpiRunSnapshots(id);
  return res.json({ data });
});

router.get('/kpis/snapshots', async (req: Request, res: Response) => {
  const kpiName = typeof req.query.kpi_name === 'string' ? req.query.kpi_name : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await listKpiSnapshots({ kpiName, from, to, limit, offset });
  return res.json({ data, paging: { limit, offset } });
});

router.post('/kpis/runs/:id/rollup-inputs', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid KPI run id.' });
  const parsed = kpiRollupInputsCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createKpiRollupInputs(id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'KPI run not found.' });
    console.error(error);
    return res.status(500).json({ error: 'Failed to create KPI rollup inputs.' });
  }
});

router.get('/kpis/runs/:id/rollup-inputs', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid KPI run id.' });
  const data = await listKpiRollupInputs(id);
  return res.json({ data });
});

export default router;

