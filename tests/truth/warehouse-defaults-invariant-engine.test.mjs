import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  warehouseDefaultsInvariantEngine
} = require('../../src/domain/warehouseDefaults/warehouseDefaultsInvariantEngine.ts');

test('warehouse defaults invariant engine reports deterministic failures and repair metadata', () => {
  const result = warehouseDefaultsInvariantEngine.evaluate(
    {
      tenantId: 'tenant-1',
      warehouseId: 'warehouse-1',
      warehouseRoot: {
        role: null,
        is_sellable: false,
        parent_location_id: null
      },
      mappedRoles: ['SELLABLE', 'QA'],
      defaultsByRole: {
        SELLABLE: {
          defaultLocationId: 'loc-1',
          mappingId: 'map-1',
          existingDefault: {
            tenant_id: 'tenant-1',
            role: 'SELLABLE',
            parent_location_id: 'warehouse-1',
            warehouse_id: 'warehouse-1',
            type: 'bin',
            is_sellable: false
          }
        },
        QA: {
          defaultLocationId: 'loc-2',
          mappingId: 'map-2',
          existingDefault: {
            tenant_id: 'tenant-1',
            role: 'QA',
            parent_location_id: 'warehouse-1',
            warehouse_id: 'warehouse-1',
            type: 'bin',
            is_sellable: false
          }
        }
      }
    },
    { includeRoot: true, includeRequiredRoles: true, includeRoleStates: true }
  );

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.failures.map((failure) => [failure.invariant, failure.role ?? null, failure.reason ?? null]),
    [
      ['default_location_sellable_flag_valid', 'SELLABLE', 'sellable_flag'],
      ['default_location_state_valid', 'HOLD', 'missing_location'],
      ['default_location_state_valid', 'REJECT', 'missing_location'],
      ['default_location_state_valid', 'SCRAP', 'missing_location'],
      ['default_roles_present', null, 'missing_required_roles']
    ]
  );
  assert.deepEqual(result.missingRoles, ['HOLD', 'REJECT']);
  assert.deepEqual(result.roleEvaluations.SELLABLE.repairBehavior, {
    requiresMappingDeletion: true,
    shouldRepair: true,
    shouldProvisionLocation: true,
    blocksValidation: true
  });
  assert.deepEqual(result.roleEvaluations.HOLD.repairBehavior, {
    requiresMappingDeletion: false,
    shouldRepair: false,
    shouldProvisionLocation: true,
    blocksValidation: true
  });
  assert.equal(result.roleEvaluations.SCRAP.repairBehavior.blocksValidation, false);
  assert.deepEqual(result.roleEvaluations.SELLABLE.failures, [
    { invariant: 'default_location_sellable_flag_valid', reason: 'sellable_flag' }
  ]);
});
