import { config } from 'dotenv';
import { query } from '../src/db';
import { computeInventoryHealth } from '../src/domains/inventory/health.service';

config();

async function loadTenants(): Promise<string[]> {
  const result = await query<{ id: string }>('SELECT id FROM tenants ORDER BY name');
  return result.rows.map((row) => row.id);
}

async function run() {
  const tenantId = process.env.TENANT_ID;
  const tenants = tenantId ? [tenantId] : await loadTenants();

  if (tenants.length === 0) {
    console.error('No tenants found.');
    process.exit(1);
  }

  let failed = false;
  for (const id of tenants) {
    const health = await computeInventoryHealth(id);
    console.log(JSON.stringify({ tenantId: id, health }, null, 2));
    if (!health.gate.pass) {
      failed = true;
    }
  }

  process.exit(failed ? 2 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
