import { query } from '../db';
import { computeInventoryHealth } from '../domains/inventory/health.service';
import { emitEvent } from '../lib/events';

let isRunning = false;
let lastRunTime: Date | null = null;
let lastRunDuration: number | null = null;

type Tenant = { id: string; name: string; slug: string };

async function getAllActiveTenants(): Promise<Tenant[]> {
  const result = await query<{ id: string; name: string; slug: string }>(
    'SELECT id, name, slug FROM tenants ORDER BY name'
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug
  }));
}

export async function runInventoryHealthCheck(): Promise<void> {
  if (isRunning) {
    console.warn('⚠️  Inventory health check already running, skipping');
    return;
  }

  isRunning = true;
  const start = Date.now();

  try {
    const tenants = await getAllActiveTenants();
    for (const tenant of tenants) {
      try {
        const health = await computeInventoryHealth(tenant.id);
        emitEvent(tenant.id, 'inventory.changed', {
          tenantId: tenant.id,
          gate: health.gate,
          negativeInventoryCount: health.negativeInventory.count,
          ledgerVariancePct: health.ledgerVsCostLayers.variancePct,
          cycleVariancePct: health.cycleCountVariance.variancePct,
          generatedAt: health.generatedAt
        });

        if (!health.gate.pass) {
          console.warn(
            `Inventory health gate failed for tenant ${tenant.slug}: ${health.gate.reasons.join(', ')}`
          );
        }
      } catch (error) {
        console.error(`Inventory health check failed for tenant ${tenant.slug}:`, error);
      }
    }

    lastRunTime = new Date();
    lastRunDuration = Date.now() - start;
  } finally {
    isRunning = false;
  }
}

export function getInventoryHealthJobStatus() {
  return {
    isRunning,
    lastRunTime,
    lastRunDuration
  };
}
