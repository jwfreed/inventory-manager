import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  getDemandVolatilitySignals,
  getExcessInventorySignals,
  getForecastAccuracySignals,
  getInventoryCoverageSignals,
  getInventoryIntelligenceOverview,
  getInventoryIntegritySignals,
  getInventoryRiskSignals,
  getOperationalFlowSignals,
  getPerformanceMetricSignals,
  getSupplyReliabilitySignals,
  getSystemReadinessSignals
} from '../services/inventorySignals.service';

const router = Router();

const querySchema = z.object({
  warehouseId: z.string().uuid().optional(),
  windowDays: z.coerce.number().int().min(7).max(365).optional(),
  forceRefresh: z.coerce.boolean().optional()
});

function parseOptions(req: Request, res: Response) {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query params.', details: parsed.error.format() });
    return null;
  }
  return parsed.data;
}

router.get('/overview', async (req: Request, res: Response) => {
  const options = parseOptions(req, res);
  if (!options) return;
  try {
    const data = await getInventoryIntelligenceOverview(req.auth!.tenantId, options);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute inventory intelligence overview.' });
  }
});

router.get('/inventory-integrity', async (req: Request, res: Response) => {
  const options = parseOptions(req, res);
  if (!options) return;
  try {
    const data = await getInventoryIntegritySignals(req.auth!.tenantId, options);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute inventory integrity signals.' });
  }
});

router.get('/inventory-risk', async (req: Request, res: Response) => {
  const options = parseOptions(req, res);
  if (!options) return;
  try {
    const data = await getInventoryRiskSignals(req.auth!.tenantId, options);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute inventory risk signals.' });
  }
});

router.get('/inventory-coverage', async (req: Request, res: Response) => {
  const options = parseOptions(req, res);
  if (!options) return;
  try {
    const data = await getInventoryCoverageSignals(req.auth!.tenantId, options);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute inventory coverage signals.' });
  }
});

router.get('/flow-reliability', async (req: Request, res: Response) => {
  const options = parseOptions(req, res);
  if (!options) return;
  try {
    const data = await getOperationalFlowSignals(req.auth!.tenantId, options);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute flow reliability signals.' });
  }
});

router.get('/supply-reliability', async (req: Request, res: Response) => {
  const options = parseOptions(req, res);
  if (!options) return;
  try {
    const data = await getSupplyReliabilitySignals(req.auth!.tenantId, options);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute supply reliability signals.' });
  }
});

router.get('/excess-inventory', async (req: Request, res: Response) => {
  const options = parseOptions(req, res);
  if (!options) return;
  try {
    const data = await getExcessInventorySignals(req.auth!.tenantId, options);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute excess inventory signals.' });
  }
});

router.get('/demand-volatility', async (req: Request, res: Response) => {
  const options = parseOptions(req, res);
  if (!options) return;
  try {
    const data = await getDemandVolatilitySignals(req.auth!.tenantId, options);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute demand volatility signals.' });
  }
});

router.get('/forecast-accuracy', async (req: Request, res: Response) => {
  const options = parseOptions(req, res);
  if (!options) return;
  try {
    const data = await getForecastAccuracySignals(req.auth!.tenantId, options);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute forecast accuracy signals.' });
  }
});

router.get('/system-readiness', async (req: Request, res: Response) => {
  const options = parseOptions(req, res);
  if (!options) return;
  try {
    const data = await getSystemReadinessSignals(req.auth!.tenantId, options);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute system readiness signals.' });
  }
});

router.get('/performance-metrics', async (req: Request, res: Response) => {
  const options = parseOptions(req, res);
  if (!options) return;
  try {
    const data = await getPerformanceMetricSignals(req.auth!.tenantId, options);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute performance metric signals.' });
  }
});

export default router;
