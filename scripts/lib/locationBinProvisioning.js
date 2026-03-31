const { v5: uuidv5 } = require('uuid');

const DEFAULT_BIN_NAMESPACE = 'ff6e4f7d-5c46-4f35-9f0d-8fcfefb44311';

async function ensureLocationHasAtLeastOneBin(locationId, tenantId, tx) {
  if (!tx || typeof tx.query !== 'function') {
    throw new Error('LOCATION_BIN_PROVISIONING_TX_REQUIRED');
  }

  const existingRes = await tx.query(
    `SELECT id
       FROM inventory_bins
      WHERE tenant_id = $1
        AND location_id = $2
      ORDER BY is_default DESC, created_at ASC, id ASC
      LIMIT 1`,
    [tenantId, locationId]
  );
  if ((existingRes.rowCount ?? 0) > 0) {
    return {
      created: false,
      binId: existingRes.rows[0].id
    };
  }

  const locationRes = await tx.query(
    `SELECT warehouse_id, code, name, type
       FROM locations
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [tenantId, locationId]
  );
  if ((locationRes.rowCount ?? 0) !== 1) {
    throw new Error('LOCATION_BIN_PROVISIONING_LOCATION_NOT_FOUND');
  }

  const location = locationRes.rows[0];
  if (location.type === 'warehouse') {
    throw new Error('LOCATION_BIN_PROVISIONING_INVALID_LOCATION_TYPE');
  }

  const binId = uuidv5(`${tenantId}:${locationId}:DEFAULT`, DEFAULT_BIN_NAMESPACE);
  const code =
    typeof location.code === 'string' && location.code.trim().length > 0
      ? `${location.code.trim()}-DEFAULT`
      : 'DEFAULT';
  const name =
    typeof location.name === 'string' && location.name.trim().length > 0
      ? `${location.name.trim()} Default Bin`
      : 'Default Bin';

  await tx.query(
    `INSERT INTO inventory_bins (
        id,
        tenant_id,
        warehouse_id,
        location_id,
        code,
        name,
        is_default,
        active,
        created_at,
        updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, true, true, now(), now())
     ON CONFLICT DO NOTHING`,
    [binId, tenantId, location.warehouse_id, locationId, code, name]
  );

  const ensuredRes = await tx.query(
    `SELECT id
       FROM inventory_bins
      WHERE tenant_id = $1
        AND location_id = $2
      ORDER BY is_default DESC, created_at ASC, id ASC
      LIMIT 1`,
    [tenantId, locationId]
  );
  if ((ensuredRes.rowCount ?? 0) !== 1) {
    throw new Error('LOCATION_BIN_PROVISIONING_FAILED');
  }

  return {
    created: ensuredRes.rows[0].id === binId,
    binId: ensuredRes.rows[0].id
  };
}

module.exports = {
  ensureLocationHasAtLeastOneBin
};
