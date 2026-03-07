import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import {
  compareBalances,
  compareItemQuantitySummaries,
  compareItemValuationSummaries,
  repairBalancesFromLedger,
  repairItemQuantitySummaries,
  repairItemValuationSummaries,
  type BalanceMismatchRow
} from '../services/inventoryLedgerReconcile.service';

type Tenant = { id: string; name: string; slug: string };
type ReconcileSummary = {
  tenantId: string;
  tenantSlug: string;
  mismatchCount: number;
  repairedCount: number;
  itemQuantityMismatchCount: number;
  itemQuantityRepairedCount: number;
  itemValuationMismatchCount: number;
  itemValuationRepairedCount: number;
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
    const itemQuantityMismatches = await compareItemQuantitySummaries(tenant.id, { tolerance });
    const itemValuationMismatches = await compareItemValuationSummaries(tenant.id, { tolerance });
    const topMismatches = mismatches.slice(0, 10);
    if (
      mode === 'strict'
      && (mismatches.length > 0 || itemQuantityMismatches.length > 0 || itemValuationMismatches.length > 0)
      && !allowRepair
    ) {
      const err: any = new Error('LEDGER_RECONCILE_STRICT_FAILED');
      err.code = 'LEDGER_RECONCILE_STRICT_FAILED';
      err.details = {
        tenantId: tenant.id,
        mismatchCount: mismatches.length,
        itemQuantityMismatchCount: itemQuantityMismatches.length,
        itemValuationMismatchCount: itemValuationMismatches.length
      };
      throw err;
    }

    let repairedCount = 0;
    let itemQuantityRepairedCount = 0;
    let itemValuationRepairedCount = 0;
    if (allowRepair && mismatches.length > 0) {
      const repair = await repairBalancesFromLedger(tenant.id, mismatches, {
        runId,
        actor: 'ledger_reconcile_job',
        maxRepairRows
      });
      repairedCount = repair.repairedCount;
    }
    if (allowRepair && itemQuantityMismatches.length > 0) {
      itemQuantityRepairedCount = await repairItemQuantitySummaries(tenant.id, itemQuantityMismatches);
    }
    if (allowRepair && itemValuationMismatches.length > 0) {
      itemValuationRepairedCount = await repairItemValuationSummaries(tenant.id, itemValuationMismatches);
    }

    const postRepairMismatches = allowRepair ? await compareBalances(tenant.id, { tolerance }) : mismatches;
    const postRepairItemQuantityMismatches = allowRepair
      ? await compareItemQuantitySummaries(tenant.id, { tolerance })
      : itemQuantityMismatches;
    const postRepairItemValuationMismatches = allowRepair
      ? await compareItemValuationSummaries(tenant.id, { tolerance })
      : itemValuationMismatches;
    if (
      mode === 'strict'
      && (
        postRepairMismatches.length > 0
        || postRepairItemQuantityMismatches.length > 0
        || postRepairItemValuationMismatches.length > 0
      )
    ) {
      const err: any = new Error('LEDGER_RECONCILE_STRICT_FAILED');
      err.code = 'LEDGER_RECONCILE_STRICT_FAILED';
      err.details = {
        tenantId: tenant.id,
        mismatchCount: postRepairMismatches.length,
        itemQuantityMismatchCount: postRepairItemQuantityMismatches.length,
        itemValuationMismatchCount: postRepairItemValuationMismatches.length
      };
      throw err;
    }

    summaries.push({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      mismatchCount: mismatches.length,
      repairedCount,
      itemQuantityMismatchCount: itemQuantityMismatches.length,
      itemQuantityRepairedCount,
      itemValuationMismatchCount: itemValuationMismatches.length,
      itemValuationRepairedCount,
      topMismatches
    });
  }

  const totalMismatches = summaries.reduce((sum, s) => sum + s.mismatchCount, 0);
  const totalRepaired = summaries.reduce((sum, s) => sum + s.repairedCount, 0);
  const totalItemQuantityMismatches = summaries.reduce((sum, s) => sum + s.itemQuantityMismatchCount, 0);
  const totalItemQuantityRepaired = summaries.reduce((sum, s) => sum + s.itemQuantityRepairedCount, 0);
  const totalItemValuationMismatches = summaries.reduce((sum, s) => sum + s.itemValuationMismatchCount, 0);
  const totalItemValuationRepaired = summaries.reduce((sum, s) => sum + s.itemValuationRepairedCount, 0);
  console.log('📊 Ledger reconcile summary', {
    mode,
    allowRepair,
    mismatchCount: totalMismatches,
    repairedCount: totalRepaired,
    itemQuantityMismatchCount: totalItemQuantityMismatches,
    itemQuantityRepairedCount: totalItemQuantityRepaired,
    itemValuationMismatchCount: totalItemValuationMismatches,
    itemValuationRepairedCount: totalItemValuationRepaired,
    topMismatches: summaries.flatMap((s) => s.topMismatches).slice(0, 10)
  });

  return summaries;
}
