import { v5 as uuidv5 } from 'uuid';
import { CANONICAL_WAREHOUSE_CODES, loadWarehouseTopology } from './warehouseTopology.mjs';

const DETERMINISTIC_NAMESPACE = '7df33ef4-e5d4-43bc-bb76-8c16418ed953';

function addIssue(issues, issue) {
  issues.push(issue);
}

function addWarning(warnings, warning) {
  warnings.push(warning);
}

function deterministicId(kind, tenantId, scopeCode) {
  return uuidv5(`${kind}:${tenantId}:${scopeCode}`, DETERMINISTIC_NAMESPACE);
}

function expectedTypeForRole(role) {
  return role === 'SCRAP' ? 'scrap' : 'bin';
}

function isRoleCandidate(location, warehouseId, role) {
  if (!location) return false;
  if (location.warehouse_id !== warehouseId) return false;
  if (location.parent_location_id !== warehouseId) return false;
  if (location.active !== true) return false;

  if (role === 'SELLABLE') {
    return location.type === 'bin' && location.is_sellable === true;
  }
  if (role === 'SCRAP') {
    return location.type === 'scrap' && location.role === 'SCRAP';
  }
  return location.type === 'bin' && location.role === role;
}

function formatCandidate(location) {
  return {
    id: location.id,
    code: location.code,
    localCode: location.local_code ?? null
  };
}

function pushAmbiguityIssues(issues, topology, warehouseByCode, locationsByWarehouseId) {
  const rolesByWarehouse = new Map();
  for (const entry of topology.defaults) {
    if (!rolesByWarehouse.has(entry.warehouseCode)) {
      rolesByWarehouse.set(entry.warehouseCode, new Set());
    }
    rolesByWarehouse.get(entry.warehouseCode).add(entry.role);
  }

  for (const [warehouseCode, roles] of rolesByWarehouse.entries()) {
    const warehouse = warehouseByCode.get(warehouseCode);
    if (!warehouse) continue;
    const locations = locationsByWarehouseId.get(warehouse.id) ?? [];
    for (const role of roles) {
      const candidates = locations.filter((location) => isRoleCandidate(location, warehouse.id, role));
      if (candidates.length > 1) {
        addIssue(issues, {
          issue: 'WAREHOUSE_ROLE_AMBIGUOUS',
          warehouseCode,
          warehouseId: warehouse.id,
          role,
          candidateCount: candidates.length,
          candidates: candidates.map(formatCandidate)
        });
      }
    }
  }
}

function isDefaultLocationValid(location, warehouseId, role) {
  if (!location) {
    return { valid: false, reason: 'missing' };
  }
  if (location.warehouse_id !== warehouseId) {
    return { valid: false, reason: 'warehouse_mismatch' };
  }
  if (location.parent_location_id !== warehouseId) {
    return { valid: false, reason: 'parent_mismatch' };
  }
  if (location.role !== role) {
    return { valid: false, reason: 'role_mismatch' };
  }
  if (location.type !== expectedTypeForRole(role)) {
    return { valid: false, reason: 'type_mismatch' };
  }
  if (role === 'SELLABLE' && location.is_sellable !== true) {
    return { valid: false, reason: 'sellable_mismatch' };
  }
  if (location.active !== true) {
    return { valid: false, reason: 'inactive' };
  }
  return { valid: true, reason: null };
}

function summarizeAndSort(issues, warnings) {
  issues.sort((left, right) => {
    const issueCompare = String(left.issue).localeCompare(String(right.issue));
    if (issueCompare !== 0) return issueCompare;
    const leftWarehouse = String(left.warehouseCode ?? '');
    const rightWarehouse = String(right.warehouseCode ?? '');
    const warehouseCompare = leftWarehouse.localeCompare(rightWarehouse);
    if (warehouseCompare !== 0) return warehouseCompare;
    return String(left.locationCode ?? left.role ?? '').localeCompare(String(right.locationCode ?? right.role ?? ''));
  });
  warnings.sort((left, right) => String(left.warning).localeCompare(String(right.warning)));
}

async function ensureTenantExists(client, tenantId) {
  const res = await client.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
  if ((res.rowCount ?? 0) === 0) {
    throw new Error(`TOPOLOGY_TENANT_NOT_FOUND tenantId=${tenantId}`);
  }
}

async function loadLocationConstraintState(client) {
  const [locationConstraintRes, locationIndexRes] = await Promise.all([
    client.query(
      `SELECT conname, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_class t
           ON t.oid = c.conrelid
         JOIN pg_namespace n
           ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'locations'
          AND c.contype = 'u'`
    ),
    client.query(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'locations'
          AND indexdef ILIKE 'CREATE UNIQUE INDEX%'`
    )
  ]);
  const uniqueDefs = [
    ...locationConstraintRes.rows.map((row) => String(row.definition ?? '')),
    ...locationIndexRes.rows.map((row) => String(row.indexdef ?? ''))
  ];

  return {
    hasTenantScopedCodeUnique: uniqueDefs.some((definition) => /\(\s*tenant_id\s*,\s*code\s*\)/i.test(definition)),
    hasGlobalCodeUnique: uniqueDefs.some(
      (definition) => /\(\s*code\s*\)/i.test(definition) && !/\(\s*tenant_id\s*,\s*code\s*\)/i.test(definition)
    ),
    hasTenantWarehouseLocalCodeUnique: uniqueDefs.some((definition) =>
      /\(\s*tenant_id\s*,\s*warehouse_id\s*,\s*local_code\s*\)/i.test(definition)
    ),
    uniqueDefs
  };
}

async function loadTopologyState(client, tenantId, topology) {
  const expectedWarehouseCodes = topology.warehouses.map((warehouse) => warehouse.code);
  const expectedLocationCodes = topology.locations.map((location) => location.code);

  const [warehouseRes, locationRes, defaultsRes, duplicateTenantCodeRes, duplicateLocalCodeRes, allWarehouseLocationsRes] =
    await Promise.all([
      client.query(
        `SELECT id, code, name, type, role, is_sellable, active, parent_location_id, warehouse_id, local_code
           FROM locations
          WHERE tenant_id = $1
            AND code = ANY($2::text[])`,
        [tenantId, expectedWarehouseCodes]
      ),
      client.query(
        `SELECT id, code, name, type, role, is_sellable, active, parent_location_id, warehouse_id, local_code
           FROM locations
          WHERE tenant_id = $1
            AND code = ANY($2::text[])`,
        [tenantId, expectedLocationCodes]
      ),
      client.query(
        `SELECT warehouse_id, role, location_id
           FROM warehouse_default_location
          WHERE tenant_id = $1`,
        [tenantId]
      ),
      client.query(
        `SELECT code, COUNT(*)::int AS duplicate_count
           FROM locations
          WHERE tenant_id = $1
          GROUP BY code
         HAVING COUNT(*) > 1
          ORDER BY duplicate_count DESC, code ASC
          LIMIT 25`,
        [tenantId]
      ),
      client.query(
        `SELECT warehouse_id, local_code, COUNT(*)::int AS duplicate_count
           FROM locations
          WHERE tenant_id = $1
            AND local_code IS NOT NULL
          GROUP BY warehouse_id, local_code
         HAVING COUNT(*) > 1
          ORDER BY duplicate_count DESC, warehouse_id, local_code
          LIMIT 25`,
        [tenantId]
      ),
      client.query(
        `SELECT id, code, local_code, warehouse_id, parent_location_id, type, role, is_sellable, active
           FROM locations
          WHERE tenant_id = $1
            AND warehouse_id IN (
              SELECT id
                FROM locations
               WHERE tenant_id = $1
                 AND code = ANY($2::text[])
                 AND type = 'warehouse'
            )`,
        [tenantId, expectedWarehouseCodes]
      )
    ]);

  const warehouseByCode = new Map(warehouseRes.rows.map((row) => [row.code, row]));
  const locationByCode = new Map(locationRes.rows.map((row) => [row.code, row]));
  const defaultsByWarehouseRole = new Map(
    defaultsRes.rows.map((row) => [`${row.warehouse_id}:${row.role}`, row])
  );

  const defaultLocationIds = Array.from(new Set(defaultsRes.rows.map((row) => row.location_id)));
  let defaultLocationById = new Map();
  if (defaultLocationIds.length > 0) {
    const defaultLocationsRes = await client.query(
      `SELECT id, code, role, type, is_sellable, active, parent_location_id, warehouse_id, local_code
         FROM locations
        WHERE tenant_id = $1
          AND id = ANY($2::uuid[])`,
      [tenantId, defaultLocationIds]
    );
    defaultLocationById = new Map(defaultLocationsRes.rows.map((row) => [row.id, row]));
  }

  const locationsByWarehouseId = new Map();
  for (const row of allWarehouseLocationsRes.rows) {
    if (!locationsByWarehouseId.has(row.warehouse_id)) {
      locationsByWarehouseId.set(row.warehouse_id, []);
    }
    locationsByWarehouseId.get(row.warehouse_id).push(row);
  }

  return {
    expectedWarehouseCodes,
    expectedLocationCodes,
    warehouseByCode,
    locationByCode,
    defaultsByWarehouseRole,
    defaultLocationById,
    locationsByWarehouseId,
    duplicateTenantCodeRows: duplicateTenantCodeRes.rows,
    duplicateLocalCodeRows: duplicateLocalCodeRes.rows
  };
}

async function evaluateTopologyState(client, tenantId, topology) {
  const issues = [];
  const warnings = [];
  const constraintState = await loadLocationConstraintState(client);
  const topologyState = await loadTopologyState(client, tenantId, topology);

  if (!constraintState.hasTenantScopedCodeUnique) {
    addIssue(issues, {
      issue: 'LOCATION_CODE_SCOPE_INVALID',
      expected: 'UNIQUE (tenant_id, code)',
      message: 'locations code uniqueness is not tenant-scoped'
    });
  }
  if (constraintState.hasGlobalCodeUnique) {
    addWarning(warnings, {
      warning: 'LOCATION_CODE_SCOPE_GLOBAL',
      message: 'locations has a global UNIQUE(code); this is broader than tenant scope'
    });
  }
  if (!constraintState.hasTenantWarehouseLocalCodeUnique) {
    addIssue(issues, {
      issue: 'LOCATION_LOCAL_CODE_SCOPE_INVALID',
      expected: 'UNIQUE (tenant_id, warehouse_id, local_code) WHERE local_code IS NOT NULL',
      message: 'locations local_code uniqueness is not warehouse-scoped'
    });
  }

  for (const row of topologyState.duplicateTenantCodeRows) {
    addIssue(issues, {
      issue: 'LOCATION_CODE_DUPLICATE_WITHIN_TENANT',
      code: row.code,
      duplicateCount: Number(row.duplicate_count)
    });
  }

  for (const row of topologyState.duplicateLocalCodeRows) {
    addIssue(issues, {
      issue: 'LOCATION_LOCAL_CODE_DUPLICATE_WITHIN_WAREHOUSE',
      warehouseId: row.warehouse_id,
      localCode: row.local_code,
      duplicateCount: Number(row.duplicate_count)
    });
  }

  pushAmbiguityIssues(
    issues,
    topology,
    topologyState.warehouseByCode,
    topologyState.locationsByWarehouseId
  );

  const expectedLocationByWarehouseAndLocalCode = new Map();
  for (const expectedWarehouse of topology.warehouses) {
    const actual = topologyState.warehouseByCode.get(expectedWarehouse.code);
    if (!actual) {
      addIssue(issues, {
        issue: 'MISSING_WAREHOUSE',
        warehouseCode: expectedWarehouse.code,
        message: `Missing warehouse root ${expectedWarehouse.code}`
      });
      continue;
    }

    if (actual.type !== 'warehouse') {
      addIssue(issues, {
        issue: 'WAREHOUSE_TYPE_INVALID',
        warehouseCode: expectedWarehouse.code,
        locationId: actual.id,
        actualType: actual.type
      });
    }
    if (actual.parent_location_id !== null) {
      addIssue(issues, {
        issue: 'WAREHOUSE_PARENT_INVALID',
        warehouseCode: expectedWarehouse.code,
        locationId: actual.id,
        parentLocationId: actual.parent_location_id
      });
    }
    if (actual.role !== null) {
      addIssue(issues, {
        issue: 'WAREHOUSE_ROLE_INVALID',
        warehouseCode: expectedWarehouse.code,
        locationId: actual.id,
        role: actual.role
      });
    }
    if (actual.is_sellable !== false) {
      addIssue(issues, {
        issue: 'WAREHOUSE_SELLABLE_INVALID',
        warehouseCode: expectedWarehouse.code,
        locationId: actual.id,
        isSellable: actual.is_sellable
      });
    }
    if (actual.warehouse_id !== actual.id) {
      addIssue(issues, {
        issue: 'WAREHOUSE_ID_INVALID',
        warehouseCode: expectedWarehouse.code,
        locationId: actual.id,
        warehouseId: actual.warehouse_id
      });
    }
    if (Boolean(actual.active) !== Boolean(expectedWarehouse.active)) {
      addIssue(issues, {
        issue: 'WAREHOUSE_ACTIVE_MISMATCH',
        warehouseCode: expectedWarehouse.code,
        locationId: actual.id,
        expectedActive: Boolean(expectedWarehouse.active),
        actualActive: Boolean(actual.active)
      });
    }
  }

  for (const expectedLocation of topology.locations) {
    expectedLocationByWarehouseAndLocalCode.set(
      `${expectedLocation.warehouseCode}:${expectedLocation.localCode}`,
      expectedLocation
    );
    const actualWarehouse = topologyState.warehouseByCode.get(expectedLocation.warehouseCode);
    if (!actualWarehouse) continue;

    const actualLocation = topologyState.locationByCode.get(expectedLocation.code);
    if (!actualLocation) {
      addIssue(issues, {
        issue: 'MISSING_LOCATION',
        warehouseCode: expectedLocation.warehouseCode,
        localCode: expectedLocation.localCode,
        locationCode: expectedLocation.code,
        message: `Missing location ${expectedLocation.code}`
      });
      continue;
    }
    if (actualLocation.warehouse_id !== actualWarehouse.id) {
      addIssue(issues, {
        issue: 'LOCATION_WAREHOUSE_MISMATCH',
        warehouseCode: expectedLocation.warehouseCode,
        locationCode: expectedLocation.code,
        locationId: actualLocation.id,
        expectedWarehouseId: actualWarehouse.id,
        actualWarehouseId: actualLocation.warehouse_id
      });
    }
    if (actualLocation.parent_location_id !== actualWarehouse.id) {
      addIssue(issues, {
        issue: 'LOCATION_PARENT_MISMATCH',
        warehouseCode: expectedLocation.warehouseCode,
        locationCode: expectedLocation.code,
        locationId: actualLocation.id,
        expectedParentId: actualWarehouse.id,
        actualParentId: actualLocation.parent_location_id
      });
    }
    if (actualLocation.type !== expectedLocation.type) {
      addIssue(issues, {
        issue: 'LOCATION_TYPE_MISMATCH',
        warehouseCode: expectedLocation.warehouseCode,
        locationCode: expectedLocation.code,
        locationId: actualLocation.id,
        expectedType: expectedLocation.type,
        actualType: actualLocation.type
      });
    }
    if ((actualLocation.role ?? null) !== expectedLocation.role) {
      addIssue(issues, {
        issue: 'LOCATION_ROLE_MISMATCH',
        warehouseCode: expectedLocation.warehouseCode,
        locationCode: expectedLocation.code,
        locationId: actualLocation.id,
        expectedRole: expectedLocation.role,
        actualRole: actualLocation.role
      });
    }
    if (Boolean(actualLocation.is_sellable) !== expectedLocation.isSellable) {
      addIssue(issues, {
        issue: 'LOCATION_SELLABLE_MISMATCH',
        warehouseCode: expectedLocation.warehouseCode,
        locationCode: expectedLocation.code,
        locationId: actualLocation.id,
        expectedIsSellable: expectedLocation.isSellable,
        actualIsSellable: Boolean(actualLocation.is_sellable)
      });
    }
    if ((actualLocation.local_code ?? null) !== expectedLocation.localCode) {
      addIssue(issues, {
        issue: 'LOCATION_LOCAL_CODE_MISMATCH',
        warehouseCode: expectedLocation.warehouseCode,
        locationCode: expectedLocation.code,
        locationId: actualLocation.id,
        expectedLocalCode: expectedLocation.localCode,
        actualLocalCode: actualLocation.local_code ?? null
      });
    }
    if (Boolean(actualLocation.active) !== Boolean(expectedLocation.active)) {
      addIssue(issues, {
        issue: 'LOCATION_ACTIVE_MISMATCH',
        warehouseCode: expectedLocation.warehouseCode,
        locationCode: expectedLocation.code,
        locationId: actualLocation.id,
        expectedActive: Boolean(expectedLocation.active),
        actualActive: Boolean(actualLocation.active)
      });
    }
  }

  for (const expectedDefault of topology.defaults) {
    const warehouse = topologyState.warehouseByCode.get(expectedDefault.warehouseCode);
    if (!warehouse) continue;

    const defaultKey = `${warehouse.id}:${expectedDefault.role}`;
    const defaultRow = topologyState.defaultsByWarehouseRole.get(defaultKey);
    if (!defaultRow) {
      addIssue(issues, {
        issue: 'MISSING_DEFAULT',
        warehouseCode: expectedDefault.warehouseCode,
        role: expectedDefault.role,
        localCode: expectedDefault.localCode
      });
      continue;
    }

    const location = topologyState.defaultLocationById.get(defaultRow.location_id);
    const validity = isDefaultLocationValid(location, warehouse.id, expectedDefault.role);
    if (!validity.valid) {
      addIssue(issues, {
        issue: 'DEFAULT_LOCATION_INVALID',
        warehouseCode: expectedDefault.warehouseCode,
        role: expectedDefault.role,
        locationId: defaultRow.location_id,
        reason: validity.reason
      });
      continue;
    }

    const canonicalLocation = expectedLocationByWarehouseAndLocalCode.get(
      `${expectedDefault.warehouseCode}:${expectedDefault.localCode}`
    );
    const canonicalLocationRow = canonicalLocation
      ? topologyState.locationByCode.get(canonicalLocation.code)
      : null;
    if (!canonicalLocationRow) {
      addIssue(issues, {
        issue: 'DEFAULT_TARGET_LOCATION_MISSING',
        warehouseCode: expectedDefault.warehouseCode,
        role: expectedDefault.role,
        localCode: expectedDefault.localCode
      });
      continue;
    }

    if (defaultRow.location_id !== canonicalLocationRow.id) {
      addWarning(warnings, {
        warning: 'DEFAULT_LOCATION_NON_CANONICAL',
        warehouseCode: expectedDefault.warehouseCode,
        role: expectedDefault.role,
        canonicalLocationCode: canonicalLocation.code,
        canonicalLocationId: canonicalLocationRow.id,
        actualLocationId: defaultRow.location_id
      });
    }
  }

  summarizeAndSort(issues, warnings);
  return {
    expectedWarehouseCodes: CANONICAL_WAREHOUSE_CODES,
    warningCount: warnings.length,
    warnings,
    count: issues.length,
    issues
  };
}

async function createWarehouseRoot(client, tenantId, warehouse, now) {
  const id = deterministicId('warehouse', tenantId, warehouse.code);
  await client.query(
    `INSERT INTO locations (
        id,
        tenant_id,
        code,
        local_code,
        name,
        type,
        role,
        is_sellable,
        active,
        parent_location_id,
        warehouse_id,
        created_at,
        updated_at
     ) VALUES ($1, $2, $3, NULL, $4, 'warehouse', NULL, false, $5, NULL, $1, $6, $6)`,
    [id, tenantId, warehouse.code, warehouse.name, warehouse.active, now]
  );
  return id;
}

async function createWarehouseLocation(client, tenantId, location, warehouseId, now) {
  const id = deterministicId('location', tenantId, `${location.warehouseCode}:${location.localCode}`);
  await client.query(
    `INSERT INTO locations (
        id,
        tenant_id,
        code,
        local_code,
        name,
        type,
        role,
        is_sellable,
        active,
        parent_location_id,
        warehouse_id,
        created_at,
        updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $11)`,
    [
      id,
      tenantId,
      location.code,
      location.localCode,
      location.name,
      location.type,
      location.role,
      location.isSellable,
      location.active,
      warehouseId,
      now
    ]
  );
  return id;
}

function assertWarehouseRepairable(row, expectedWarehouse) {
  if (row.type !== 'warehouse') {
    throw new Error(`TOPOLOGY_NON_REPAIRABLE_WAREHOUSE warehouse=${expectedWarehouse.code} reason=type_mismatch`);
  }
  if (row.parent_location_id !== null) {
    throw new Error(`TOPOLOGY_NON_REPAIRABLE_WAREHOUSE warehouse=${expectedWarehouse.code} reason=parent_mismatch`);
  }
  if (row.role !== null) {
    throw new Error(`TOPOLOGY_NON_REPAIRABLE_WAREHOUSE warehouse=${expectedWarehouse.code} reason=role_mismatch`);
  }
  if (row.is_sellable !== false) {
    throw new Error(`TOPOLOGY_NON_REPAIRABLE_WAREHOUSE warehouse=${expectedWarehouse.code} reason=sellable_mismatch`);
  }
  if (row.warehouse_id !== row.id) {
    throw new Error(
      `TOPOLOGY_NON_REPAIRABLE_WAREHOUSE warehouse=${expectedWarehouse.code} reason=warehouse_id_mismatch`
    );
  }
  if (Boolean(row.active) !== Boolean(expectedWarehouse.active)) {
    throw new Error(`TOPOLOGY_NON_REPAIRABLE_WAREHOUSE warehouse=${expectedWarehouse.code} reason=active_mismatch`);
  }
}

function assertLocationRepairable(row, expected, warehouseId) {
  if (row.warehouse_id !== warehouseId) {
    throw new Error(`TOPOLOGY_NON_REPAIRABLE_LOCATION code=${expected.code} reason=warehouse_mismatch`);
  }
  if (row.parent_location_id !== warehouseId) {
    throw new Error(`TOPOLOGY_NON_REPAIRABLE_LOCATION code=${expected.code} reason=parent_mismatch`);
  }
  if (row.type !== expected.type) {
    throw new Error(`TOPOLOGY_NON_REPAIRABLE_LOCATION code=${expected.code} reason=type_mismatch`);
  }
  if ((row.role ?? null) !== expected.role) {
    throw new Error(`TOPOLOGY_NON_REPAIRABLE_LOCATION code=${expected.code} reason=role_mismatch`);
  }
  if (Boolean(row.is_sellable) !== expected.isSellable) {
    throw new Error(`TOPOLOGY_NON_REPAIRABLE_LOCATION code=${expected.code} reason=sellable_mismatch`);
  }
  if (row.active !== true) {
    throw new Error(`TOPOLOGY_NON_REPAIRABLE_LOCATION code=${expected.code} reason=inactive`);
  }
}

export async function checkOnly(client, tenantId, options = {}) {
  await ensureTenantExists(client, tenantId);
  const topology = options.topology ?? await loadWarehouseTopology(options);
  return evaluateTopologyState(client, tenantId, topology);
}

export async function fix(client, tenantId, options = {}) {
  await ensureTenantExists(client, tenantId);
  const topology = options.topology ?? await loadWarehouseTopology(options);
  const now = options.now ?? new Date();
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('seed_warehouse_topology:' || $1::text))`, [tenantId]);

  const summary = {
    tenantId,
    created_warehouses_count: 0,
    created_locations_count: 0,
    defaults_set_count: 0,
    warnings_count: 0
  };

  const state = await loadTopologyState(client, tenantId, topology);
  const warehouseIdByCode = new Map();

  for (const warehouse of topology.warehouses) {
    const existing = state.warehouseByCode.get(warehouse.code);
    if (!existing) {
      const createdId = await createWarehouseRoot(client, tenantId, warehouse, now);
      summary.created_warehouses_count += 1;
      warehouseIdByCode.set(warehouse.code, createdId);
      continue;
    }
    assertWarehouseRepairable(existing, warehouse);
    warehouseIdByCode.set(warehouse.code, existing.id);
  }

  const refreshedState = await loadTopologyState(client, tenantId, topology);
  const locationIdByWarehouseAndLocalCode = new Map();
  for (const location of topology.locations) {
    const warehouseId = warehouseIdByCode.get(location.warehouseCode);
    if (!warehouseId) {
      throw new Error(`TOPOLOGY_WAREHOUSE_LOOKUP_FAILED warehouse=${location.warehouseCode}`);
    }
    const existing = refreshedState.locationByCode.get(location.code);
    if (!existing) {
      const createdId = await createWarehouseLocation(client, tenantId, location, warehouseId, now);
      summary.created_locations_count += 1;
      locationIdByWarehouseAndLocalCode.set(`${location.warehouseCode}:${location.localCode}`, createdId);
      continue;
    }
    assertLocationRepairable(existing, location, warehouseId);
    if (existing.local_code === null) {
      await client.query(
        `UPDATE locations
            SET local_code = $3,
                updated_at = $4
          WHERE id = $1
            AND tenant_id = $2
            AND local_code IS NULL`,
        [existing.id, tenantId, location.localCode, now]
      );
    } else if (existing.local_code !== location.localCode) {
      throw new Error(
        `TOPOLOGY_NON_REPAIRABLE_LOCATION code=${location.code} reason=local_code_mismatch expected=${location.localCode} actual=${existing.local_code}`
      );
    }
    locationIdByWarehouseAndLocalCode.set(`${location.warehouseCode}:${location.localCode}`, existing.id);
  }

  const duplicateLocalCodeRes = await client.query(
    `SELECT warehouse_id, local_code, COUNT(*)::int AS duplicate_count
       FROM locations
      WHERE tenant_id = $1
        AND local_code IS NOT NULL
      GROUP BY warehouse_id, local_code
     HAVING COUNT(*) > 1
      LIMIT 1`,
    [tenantId]
  );
  if ((duplicateLocalCodeRes.rowCount ?? 0) > 0) {
    const row = duplicateLocalCodeRes.rows[0];
    throw new Error(
      `TOPOLOGY_NON_REPAIRABLE_LOCAL_CODE_DUPLICATE warehouseId=${row.warehouse_id} localCode=${row.local_code}`
    );
  }

  const latestState = await loadTopologyState(client, tenantId, topology);
  const ambiguityIssues = [];
  pushAmbiguityIssues(ambiguityIssues, topology, latestState.warehouseByCode, latestState.locationsByWarehouseId);
  if (ambiguityIssues.length > 0) {
    const first = ambiguityIssues[0];
    throw new Error(
      `WAREHOUSE_ROLE_AMBIGUOUS warehouse=${first.warehouseCode} role=${first.role} candidates=${JSON.stringify(
        first.candidates
      )}`
    );
  }

  const defaultsRes = await client.query(
    `SELECT warehouse_id, role, location_id
       FROM warehouse_default_location
      WHERE tenant_id = $1`,
    [tenantId]
  );
  const defaultByWarehouseRole = new Map(defaultsRes.rows.map((row) => [`${row.warehouse_id}:${row.role}`, row]));
  const defaultLocationIds = Array.from(new Set(defaultsRes.rows.map((row) => row.location_id)));
  const defaultLocationsById = new Map();
  if (defaultLocationIds.length > 0) {
    const defaultLocationRes = await client.query(
      `SELECT id, role, type, is_sellable, active, parent_location_id, warehouse_id
         FROM locations
        WHERE tenant_id = $1
          AND id = ANY($2::uuid[])`,
      [tenantId, defaultLocationIds]
    );
    for (const row of defaultLocationRes.rows) {
      defaultLocationsById.set(row.id, row);
    }
  }

  for (const defaultEntry of topology.defaults) {
    const warehouseId = warehouseIdByCode.get(defaultEntry.warehouseCode);
    const expectedLocationId = locationIdByWarehouseAndLocalCode.get(
      `${defaultEntry.warehouseCode}:${defaultEntry.localCode}`
    );
    if (!warehouseId || !expectedLocationId) {
      throw new Error(
        `TOPOLOGY_DEFAULT_RESOLVE_FAILED warehouse=${defaultEntry.warehouseCode} role=${defaultEntry.role} localCode=${defaultEntry.localCode}`
      );
    }
    const key = `${warehouseId}:${defaultEntry.role}`;
    const existing = defaultByWarehouseRole.get(key);
    if (!existing) {
      await client.query(
        `INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, warehouseId, defaultEntry.role, expectedLocationId]
      );
      summary.defaults_set_count += 1;
      continue;
    }

    const validity = isDefaultLocationValid(
      defaultLocationsById.get(existing.location_id),
      warehouseId,
      defaultEntry.role
    );
    if (!validity.valid) {
      await client.query(
        `UPDATE warehouse_default_location
            SET location_id = $4
          WHERE tenant_id = $1
            AND warehouse_id = $2
            AND role = $3`,
        [tenantId, warehouseId, defaultEntry.role, expectedLocationId]
      );
      summary.defaults_set_count += 1;
    }
  }

  const postCheck = await evaluateTopologyState(client, tenantId, topology);
  summary.warnings_count = postCheck.warningCount ?? 0;
  if (postCheck.count > 0) {
    const sample = postCheck.issues.slice(0, 10).map((issue) => JSON.stringify(issue)).join('; ');
    throw new Error(`TOPOLOGY_POSTCHECK_FAILED count=${postCheck.count} sample=${sample}`);
  }

  return summary;
}

export async function checkWarehouseTopologyDefaults(client, tenantId, options = {}) {
  return checkOnly(client, tenantId, options);
}
