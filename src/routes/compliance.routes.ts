import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import {
  lotSchema,
  movementLotAllocationsSchema,
  recallActionSchema,
  recallCaseSchema,
  recallCaseStatusPatchSchema,
  recallCaseTargetSchema,
  recallCommunicationSchema,
  recallImpactedLotSchema,
  recallImpactedShipmentSchema,
  recallTraceRunSchema,
} from '../schemas/compliance.schema';
import {
  createLot,
  createMovementLotAllocations,
  createRecallActions,
  createRecallCase,
  createRecallCommunications,
  createRecallImpactedLots,
  createRecallImpactedShipments,
  createRecallTargets,
  createRecallTraceRun,
  getLot,
  getRecallCase,
  getRecallTraceRun,
  listLots,
  listMovementLotAllocations,
  listMovementLotsByMovement,
  listRecallActions,
  listRecallCases,
  listRecallCommunications,
  listRecallImpactedLots,
  listRecallImpactedShipments,
  listRecallTargets,
  listRecallTraceRuns,
  updateRecallCaseStatus,
} from '../services/compliance.service';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/lots', async (req: Request, res: Response) => {
  const parsed = lotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const lot = await createLot(parsed.data);
    return res.status(201).json(lot);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Lot code must be unique per item.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Referenced item does not exist.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid lot status.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create lot.' });
  }
});

router.get('/lots', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const itemId = typeof req.query.item_id === 'string' ? req.query.item_id : undefined;
  const lotCode = typeof req.query.lot_code === 'string' ? req.query.lot_code : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const data = await listLots({ itemId, lotCode, status }, limit, offset);
  return res.json({ data, paging: { limit, offset } });
});

router.get('/lots/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid lot id.' });
  const lot = await getLot(id);
  if (!lot) return res.status(404).json({ error: 'Lot not found.' });
  return res.json(lot);
});

router.post('/inventory-movement-lines/:id/lots', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid movement line id.' });
  const parsed = movementLotAllocationsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createMovementLotAllocations(id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'Movement line not found.' });
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Invalid lot reference.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid allocation quantity.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create lot allocations.' });
  }
});

router.get('/inventory-movement-lines/:id/lots', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid movement line id.' });
  const data = await listMovementLotAllocations(id);
  return res.json({ data });
});

router.get('/inventory-movements/:id/lots', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid movement id.' });
  const data = await listMovementLotsByMovement(id);
  return res.json({ data });
});

router.post('/recalls/cases', async (req: Request, res: Response) => {
  const parsed = recallCaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const recall = await createRecallCase(parsed.data);
    return res.status(201).json(recall);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Recall number must be unique.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid recall status or severity.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create recall case.' });
  }
});

router.get('/recalls/cases', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const data = await listRecallCases(limit, offset);
  return res.json({ data, paging: { limit, offset } });
});

router.get('/recalls/cases/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid case id.' });
  const recall = await getRecallCase(id);
  if (!recall) return res.status(404).json({ error: 'Recall case not found.' });
  return res.json(recall);
});

router.patch('/recalls/cases/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid case id.' });
  const parsed = recallCaseStatusPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const recall = await updateRecallCaseStatus(id, parsed.data);
    if (!recall) return res.status(404).json({ error: 'Recall case not found.' });
    return res.json(recall);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      check: () => ({ status: 400, body: { error: 'Invalid status.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to update recall case.' });
  }
});

router.post('/recalls/cases/:id/targets', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid case id.' });
  const parsed = recallCaseTargetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createRecallTargets(id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'Recall case not found.' });
    if (error?.code === 'BAD_REQUEST') return res.status(400).json({ error: 'Invalid target payload.' });
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Invalid lot or item reference.' } }),
      unique: () => ({ status: 409, body: { error: 'Duplicate target for this case.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid target type.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create recall targets.' });
  }
});

router.get('/recalls/cases/:id/targets', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid case id.' });
  const data = await listRecallTargets(id);
  return res.json({ data });
});

router.post('/recalls/cases/:id/trace-runs', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid case id.' });
  const parsed = recallTraceRunSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const trace = await createRecallTraceRun(id, parsed.data);
    return res.status(201).json(trace);
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'Recall case not found.' });
    const mapped = mapPgErrorToHttp(error, {
      check: () => ({ status: 400, body: { error: 'Invalid trace run status.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create recall trace run.' });
  }
});

router.get('/recalls/cases/:id/trace-runs', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid case id.' });
  const data = await listRecallTraceRuns(id);
  return res.json({ data });
});

router.get('/recalls/trace-runs/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid trace run id.' });
  const trace = await getRecallTraceRun(id);
  if (!trace) return res.status(404).json({ error: 'Recall trace run not found.' });
  return res.json(trace);
});

router.post('/recalls/trace-runs/:id/impacted-shipments', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid trace run id.' });
  const parsed = recallImpactedShipmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createRecallImpactedShipments(id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'Recall trace run not found.' });
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Shipment already linked to this trace run.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Invalid shipment or customer reference.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create impacted shipments.' });
  }
});

router.get('/recalls/trace-runs/:id/impacted-shipments', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid trace run id.' });
  const data = await listRecallImpactedShipments(id);
  return res.json({ data });
});

router.post('/recalls/trace-runs/:id/impacted-lots', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid trace run id.' });
  const parsed = recallImpactedLotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createRecallImpactedLots(id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'Recall trace run not found.' });
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Lot role already linked to this trace run.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Invalid lot reference.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid lot role.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create impacted lots.' });
  }
});

router.get('/recalls/trace-runs/:id/impacted-lots', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid trace run id.' });
  const data = await listRecallImpactedLots(id);
  return res.json({ data });
});

router.post('/recalls/cases/:id/actions', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid case id.' });
  const parsed = recallActionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createRecallActions(id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'Recall case not found.' });
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Invalid reference on action.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid action type or status.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create recall actions.' });
  }
});

router.get('/recalls/cases/:id/actions', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid case id.' });
  const data = await listRecallActions(id);
  return res.json({ data });
});

router.post('/recalls/cases/:id/communications', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid case id.' });
  const parsed = recallCommunicationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const data = await createRecallCommunications(id, parsed.data);
    return res.status(201).json({ data });
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') return res.status(404).json({ error: 'Recall case not found.' });
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Invalid customer reference.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid communication channel or status.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create recall communications.' });
  }
});

router.get('/recalls/cases/:id/communications', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) return res.status(400).json({ error: 'Invalid case id.' });
  const data = await listRecallCommunications(id);
  return res.json({ data });
});

export default router;
