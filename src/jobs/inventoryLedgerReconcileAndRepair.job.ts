import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import {
  compareBalances,
  repairBalancesFromLedger,
  type BalanceMismatchRow
} from '../services/inventoryLedgerReconcile.service';

type Tenant = { id: string; name: string; slug: string };
type ReconcileSummary = {
  tenantId: string;
  tenantSlug: string;
  mismatchCount: number;
  repairedCount: number;
  topMismatches: BalanceMismatchRow[];
};

async function getAllTenants(): Promise<Tenant[]> {
  const result = await query<{ id: string; name: string; slug: string }>(
    'SELECT id, name, slug FROM tenants ORDER BY name'
  );
  return result.rows;
}

export async function runInventoryLedgerReconcileAndRepair(options: {
  tenantIds?: string[];
  mode?: 'report' | 'strict';
  allowRepair?: boolean;
  maxRepairRows?: number;
  tolerance?: number;
} = {}): Promise<ReconcileSummary[]> {
  const mode = options.mode ?? 'report';
  const allowRepair = options.allowRepair ?? process.env.FEATURE_BALANCE_REBUILD === 'true';
  const maxRepairRows = options.maxRepairRows;
  const tolerance = options.tolerance;
  const runId = uuidv4();

  const tenants = options.tenantIds?.length
    ? (
        await query<Tenant>(
          'SELECT id, name, slug FROM tenants WHERE id = ANY($1) ORDER BY name',
          [options.tenantIds]
        )
      ).rows
    : await getAllTenants();

  const summaries: ReconcileSummary[] = [];

  for (const tenant of tenants) {
    const mismatches = await compareBalances(tenant.id, { tolerance });
    const topMismatches = mismatches.slice(0, 10);
    if (mode === 'strict' && mismatches.length > 0 && !allowRepair) {
      const err: any = new Error('LEDGER_RECONCILE_STRICT_FAILED');
      err.code = 'LEDGER_RECONCILE_STRICT_FAILED';
      err.details = { tenantId: tenant.id, mismatchCount: mismatches.length };
      throw err;
    }

    let repairedCount = 0;
    if (allowRepair && mismatches.length > 0) {
      const repair = await repairBalancesFromLedger(tenant.id, mismatches, {
        runId,
        actor: 'ledger_reconcile_job',
        maxRepairRows
      });
      repairedCount = repair.repairedCount;
    }

    const postRepairMismatches = allowRepair ? await compareBalances(tenant.id, { tolerance }) : mismatches;
    if (mode === 'strict' && postRepairMismatches.length > 0) {
      const err: any = new Error('LEDGER_RECONCILE_STRICT_FAILED');
      err.code = 'LEDGER_RECONCILE_STRICT_FAILED';
      err.details = { tenantId: tenant.id, mismatchCount: postRepairMismatches.length };
      throw err;
    }

    summaries.push({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      mismatchCount: mismatches.length,
      repairedCount,
      topMismatches
    });
  }

  const totalMismatches = summaries.reduce((sum, s) => sum + s.mismatchCount, 0);
  const totalRepaired = summaries.reduce((sum, s) => sum + s.repairedCount, 0);
  console.log('📊 Ledger reconcile summary', {
    mode,
    allowRepair,
    mismatchCount: totalMismatches,
    repairedCount: totalRepaired,
    topMismatches: summaries.flatMap((s) => s.topMismatches).slice(0, 10)
  });

  return summaries;
}
