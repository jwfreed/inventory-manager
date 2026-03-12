import { query } from '../db';
import { emitEvent } from '../lib/events';
import { getInventoryIntelligenceOverview } from '../services/inventorySignals.service';

let isRunning = false;
let lastRunTime: Date | null = null;
let lastRunDuration: number | null = null;

type Tenant = { id: string; slug: string };

async function getAllTenants(): Promise<Tenant[]> {
  const result = await query<Tenant>('SELECT id, slug FROM tenants ORDER BY slug');
  return result.rows;
}

export async function refreshInventorySignalCache(): Promise<void> {
  if (isRunning) {
    console.warn('⚠️  Inventory signal refresh already running, skipping');
    return;
  }

  isRunning = true;
  const startedAt = Date.now();
  try {
    const tenants = await getAllTenants();
    for (const tenant of tenants) {
      try {
        const overview = await getInventoryIntelligenceOverview(tenant.id, {
          windowDays: 90,
          forceRefresh: true
        });

        emitEvent(tenant.id, 'dashboard.inventory-signals.updated', {
          tenantId: tenant.id,
          asOf: overview.asOf,
          exceptionCount: overview.exceptions.length,
          coverageSignals: overview.sections.inventoryCoverage.metrics.length,
          riskSignals: overview.sections.inventoryRisk.metrics.length
        });
      } catch (error) {
        console.error(`Inventory signal refresh failed for tenant ${tenant.slug}:`, error);
      }
    }
    lastRunTime = new Date();
    lastRunDuration = Date.now() - startedAt;
  } finally {
    isRunning = false;
  }
}

export function getInventorySignalsJobStatus() {
  return {
    isRunning,
    lastRunTime,
    lastRunDuration
  };
}
