// TEST-ONLY: may provision/repair topology; do not call from production paths.
import { randomUUID } from 'node:crypto';
import { ensureDbSession } from './ensureDbSession.mjs';
import { seedWarehouseTopologyForTenant } from '../../scripts/seed_warehouse_topology.mjs';

const topologyReadyTenants = new Set();
const topologyInflightByTenant = new Map();

async function ensureTopologyForTenant(pool, tenantId) {
  if (topologyReadyTenants.has(tenantId)) return;
  if (topologyInflightByTenant.has(tenantId)) {
    await topologyInflightByTenant.get(tenantId);
    return;
  }

  const inflight = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      await seedWarehouseTopologyForTenant(client, tenantId, { fix: true });
      await client.query('COMMIT');
      topologyReadyTenants.add(tenantId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  })();

  topologyInflightByTenant.set(tenantId, inflight);
  try {
    await inflight;
  } finally {
    topologyInflightByTenant.delete(tenantId);
  }
}

export async function getTestTenantWithValidTopology({
  tenantSlug,
  tenantName
} = {}) {
  const session = await ensureDbSession({
    tenantSlug: tenantSlug ?? `topology-valid-${randomUUID().slice(0, 8)}`,
    tenantName: tenantName ?? 'Topology Valid Test Tenant'
  });
  const tenantId = session.tenant?.id;
  if (!tenantId) {
    throw new Error('TOPOLOGY_VALID_TENANT_REQUIRED missing tenant id in ensureDbSession response');
  }
  await ensureTopologyForTenant(session.pool, tenantId);
  return session;
}
