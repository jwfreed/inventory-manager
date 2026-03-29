import test from 'node:test';
import assert from 'node:assert/strict';
import {
  warehouseDefaultsPolicyContract,
  type LocationRole,
  type WarehouseDefaultInvalidReason,
  type WarehouseDefaultLocationState
} from '../../src/domain/warehouseDefaults/warehouseDefaultsPolicy.contract';
import {
  warehouseDefaultsInvariantRegistry,
  warehouseDefaultsInvariants
} from '../../src/domain/warehouseDefaults/warehouseDefaultsInvariants';

function buildDefault(overrides: Partial<WarehouseDefaultLocationState> = {}): WarehouseDefaultLocationState {
  return {
    tenant_id: 'tenant-1',
    role: 'SELLABLE',
    parent_location_id: 'warehouse-1',
    warehouse_id: 'warehouse-1',
    type: 'bin',
    is_sellable: true,
    ...overrides
  };
}

test('policy contract exposes expected roles, expectations, and invariant names', () => {
  assert.deepEqual(warehouseDefaultsPolicyContract.roles.required, ['SELLABLE', 'QA', 'HOLD', 'REJECT']);
  assert.deepEqual(warehouseDefaultsPolicyContract.roles.all, ['SELLABLE', 'QA', 'HOLD', 'REJECT', 'SCRAP']);
  assert.deepEqual(warehouseDefaultsPolicyContract.roles.expectedByRole.SCRAP, {
    type: 'scrap',
    is_sellable: null,
    required: false
  });
  assert.deepEqual(warehouseDefaultsPolicyContract.roles.expectedByRole.SELLABLE, {
    type: 'bin',
    is_sellable: true,
    required: true
  });
  assert.deepEqual(Object.keys(warehouseDefaultsPolicyContract.invariants), [
    'warehouse_has_valid_root',
    'default_roles_present',
    'default_location_state_valid',
    'default_location_type_valid',
    'default_location_sellable_flag_valid',
    'recovered_warehouse_root_eligible',
    'unresolved_orphan_reason_classified'
  ]);
});

test('detectInvalidReason preserves the current reason ordering', () => {
  const cases: Array<{
    name: string;
    role: LocationRole;
    existingDefault: WarehouseDefaultLocationState | null;
    expected: WarehouseDefaultInvalidReason | null;
  }> = [
    { name: 'missing location', role: 'SELLABLE', existingDefault: null, expected: 'missing_location' },
    { name: 'tenant mismatch', role: 'SELLABLE', existingDefault: buildDefault({ tenant_id: 'tenant-2' }), expected: 'tenant_mismatch' },
    { name: 'role mismatch', role: 'SELLABLE', existingDefault: buildDefault({ role: 'QA' }), expected: 'role_mismatch' },
    { name: 'sellable flag', role: 'SELLABLE', existingDefault: buildDefault({ is_sellable: false }), expected: 'sellable_flag' },
    { name: 'warehouse drift', role: 'SELLABLE', existingDefault: buildDefault({ warehouse_id: 'warehouse-2' }), expected: 'warehouse_drift' },
    { name: 'parent drift', role: 'SELLABLE', existingDefault: buildDefault({ parent_location_id: 'warehouse-2' }), expected: 'parent_drift' },
    { name: 'type mismatch', role: 'SCRAP', existingDefault: buildDefault({ role: 'SCRAP', type: 'bin', is_sellable: false }), expected: 'type_mismatch' },
    { name: 'valid state', role: 'SELLABLE', existingDefault: buildDefault(), expected: null }
  ];

  for (const entry of cases) {
    assert.equal(
      warehouseDefaultsPolicyContract.defaults.detectInvalidReason({
        tenantId: 'tenant-1',
        warehouseId: 'warehouse-1',
        role: entry.role,
        existingDefault: entry.existingDefault
      }),
      entry.expected,
      entry.name
    );
  }
});

test('missing required roles are calculated from the contract role set', () => {
  assert.deepEqual(
    warehouseDefaultsPolicyContract.roles.getMissingRequiredRoles(['SELLABLE', 'REJECT']),
    ['QA', 'HOLD']
  );
  assert.deepEqual(
    warehouseDefaultsPolicyContract.roles.getMissingRequiredRoles(['SELLABLE', 'QA', 'HOLD', 'REJECT', 'SCRAP']),
    []
  );
});

test('repair decision contract remains explicit and stable', () => {
  assert.deepEqual(warehouseDefaultsPolicyContract.repair.getRepairDecision(null), {
    reason: null,
    requiresMappingDeletion: false,
    shouldRepair: false
  });
  assert.deepEqual(warehouseDefaultsPolicyContract.repair.getRepairDecision('missing_location'), {
    reason: 'missing_location',
    requiresMappingDeletion: true,
    shouldRepair: false
  });
  assert.equal(warehouseDefaultsPolicyContract.repair.shouldRepair('tenant_mismatch'), true);
  assert.equal(warehouseDefaultsPolicyContract.repair.shouldRepair('missing_warehouse'), true);
});

test('topology validity rules remain explicit and stable', () => {
  assert.equal(
    warehouseDefaultsPolicyContract.topology.isWarehouseRootValid({
      role: null,
      is_sellable: false,
      parent_location_id: null
    }),
    true
  );
  assert.equal(
    warehouseDefaultsPolicyContract.topology.isWarehouseRootValid({
      role: 'SELLABLE',
      is_sellable: false,
      parent_location_id: null
    }),
    false
  );
  assert.equal(
    warehouseDefaultsPolicyContract.topology.shouldCreateRecoveredWarehouseRoot({
      warehouse_id: 'warehouse-1',
      warehouse_type: null,
      derived_parent_warehouse_id: null
    }),
    true
  );
  assert.equal(
    warehouseDefaultsPolicyContract.topology.shouldCreateRecoveredWarehouseRoot({
      warehouse_id: 'warehouse-1',
      warehouse_type: null,
      derived_parent_warehouse_id: 'warehouse-2'
    }),
    false
  );
  assert.equal(
    warehouseDefaultsPolicyContract.topology.getUnresolvedOrphanWarehouseRootsReason(0),
    'remaining_orphan_roots'
  );
  assert.equal(
    warehouseDefaultsPolicyContract.topology.getUnresolvedOrphanWarehouseRootsReason(2),
    'local_code_conflict'
  );
});

test('invariant registry evaluates the policy rules directly', () => {
  assert.deepEqual(
    warehouseDefaultsInvariantRegistry.map((invariant) => invariant.name),
    [
      'warehouse_has_valid_root',
      'default_roles_present',
      'default_location_state_valid',
      'default_location_type_valid',
      'default_location_sellable_flag_valid',
      'recovered_warehouse_root_eligible',
      'unresolved_orphan_reason_classified'
    ]
  );
  assert.equal(
    warehouseDefaultsInvariants.warehouse_has_valid_root.evaluate({
      role: null,
      is_sellable: false,
      parent_location_id: null
    }),
    true
  );
  assert.deepEqual(
    warehouseDefaultsInvariants.default_roles_present.evaluate({
      roles: ['SELLABLE', 'QA']
    }),
    { valid: false, missingRoles: ['HOLD', 'REJECT'] }
  );
  assert.equal(
    warehouseDefaultsInvariants.default_location_state_valid.evaluate({
      tenantId: 'tenant-1',
      warehouseId: 'warehouse-1',
      role: 'SELLABLE',
      existingDefault: buildDefault()
    }),
    true
  );
  assert.equal(
    warehouseDefaultsInvariants.default_location_type_valid.evaluate({
      role: 'SCRAP',
      type: 'bin'
    }),
    false
  );
  assert.equal(
    warehouseDefaultsInvariants.default_location_sellable_flag_valid.evaluate({
      role: 'SELLABLE',
      existingDefault: buildDefault({ is_sellable: false })
    }),
    false
  );
  assert.equal(
    warehouseDefaultsInvariants.recovered_warehouse_root_eligible.evaluate({
      warehouse_id: 'warehouse-1',
      warehouse_type: null,
      derived_parent_warehouse_id: 'warehouse-2'
    }),
    false
  );
  assert.equal(
    warehouseDefaultsInvariants.unresolved_orphan_reason_classified.evaluate({
      conflictCount: 1
    }),
    'local_code_conflict'
  );
});
