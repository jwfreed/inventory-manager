import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { getTestTenantWithValidTopology } from '../helpers/topologyTenant.mjs';

const execFileAsync = promisify(execFile);

test('strict invariants pass for a test tenant with canonical topology', { timeout: 120000 }, async () => {
  const session = await getTestTenantWithValidTopology({
    tenantName: 'Strict Invariants Topology Tenant'
  });
  const tenantId = session.tenant?.id;
  assert.ok(tenantId, 'tenantId is required');

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['scripts/inventory_invariants_check.mjs', '--strict', '--tenant-id', tenantId, '--limit', '25'],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024
    }
  );

  assert.equal(stderr.trim(), '', stderr);
  assert.match(stdout, /\[warehouse_topology_defaults_invalid\] count=0/);
});
