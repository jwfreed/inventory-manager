import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { runInventoryLedgerReconcileAndRepair } from '../jobs/inventoryLedgerReconcileAndRepair.job';

const router = Router();

const bodySchema = z.object({
  mode: z.enum(['report', 'strict']).optional(),
  repair: z.boolean().optional(),
  maxRepairRows: z.number().int().min(0).optional(),
  tolerance: z.number().positive().optional(),
  tenantIds: z.array(z.string().uuid()).optional()
});

router.post('/admin/inventory-ledger/reconcile', async (req: Request, res: Response) => {
  if (req.auth?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload.', details: parsed.error.format() });
  }

  try {
    const data = parsed.data;
    const results = await runInventoryLedgerReconcileAndRepair({
      tenantIds: data.tenantIds,
      mode: data.mode ?? 'report',
      allowRepair: data.repair ?? false,
      maxRepairRows: data.maxRepairRows,
      tolerance: data.tolerance
    });
    return res.status(200).json({ data: results });
  } catch (error: any) {
    if (error?.code === 'BALANCE_REPAIR_THRESHOLD_EXCEEDED') {
      return res.status(409).json({ error: 'Repair threshold exceeded.', details: error.details });
    }
    if (error?.code === 'LEDGER_RECONCILE_STRICT_FAILED') {
      return res.status(409).json({ error: 'Ledger reconcile strict mode failed.', details: error.details });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to reconcile ledger balances.' });
  }
});

export default router;
