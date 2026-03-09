import assert from 'node:assert/strict';

export async function findMovementBySourceType(db, tenantId, sourceType) {
  const result = await db.query(
    `SELECT id, movement_type, source_type, source_id, idempotency_key
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [tenantId, sourceType]
  );
  assert.equal(result.rowCount, 1, `missing movement for source_type=${sourceType}`);
  return result.rows[0];
}

export async function findMovementBySourceId(db, tenantId, sourceType, sourceId) {
  const result = await db.query(
    `SELECT id, movement_type, source_type, source_id, idempotency_key
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_type = $2
        AND source_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [tenantId, sourceType, sourceId]
  );
  assert.equal(result.rowCount, 1, `missing movement for ${sourceType}:${sourceId}`);
  return result.rows[0];
}

export async function findMovementByIdempotencyKey(db, tenantId, idempotencyKey) {
  const result = await db.query(
    `SELECT id, movement_type, source_type, source_id, idempotency_key
       FROM inventory_movements
      WHERE tenant_id = $1
        AND idempotency_key = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [tenantId, idempotencyKey]
  );
  assert.equal(result.rowCount, 1, `missing movement for idempotency_key=${idempotencyKey}`);
  return result.rows[0];
}

export async function assertMovementContract({
  harness,
  movementId,
  expectedMovementType,
  expectedSourceType,
  expectedLineCount,
  expectedBalances = []
}) {
  const { pool: db, tenantId } = harness;
  const movementResult = await db.query(
    `SELECT movement_type, source_type, movement_deterministic_hash
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, movementId]
  );
  assert.equal(movementResult.rowCount, 1);
  assert.equal(movementResult.rows[0].movement_type, expectedMovementType);
  assert.equal(movementResult.rows[0].source_type, expectedSourceType);
  assert.match(movementResult.rows[0].movement_deterministic_hash ?? '', /^[a-f0-9]{64}$/);

  const lineResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2`,
    [tenantId, movementId]
  );
  assert.equal(Number(lineResult.rows[0]?.count ?? 0), expectedLineCount);

  const eventResult = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM inventory_events
      WHERE tenant_id = $1
        AND aggregate_type = 'inventory_movement'
        AND aggregate_id = $2
        AND event_type = 'inventory.movement.posted'`,
    [tenantId, movementId]
  );
  assert.ok(Number(eventResult.rows[0]?.count ?? 0) >= 1, `missing inventory.movement.posted for ${movementId}`);

  for (const balance of expectedBalances) {
    const onHand = await harness.readOnHand(balance.itemId, balance.locationId);
    assert.equal(onHand, balance.onHand);
  }

  const audit = await harness.auditReplayDeterminism(25);
  assert.equal(audit.movementAudit.rowsMissingDeterministicHash, 0);
  assert.equal(audit.movementAudit.replayIntegrityFailures.count, 0);
  assert.equal(audit.eventRegistryFailures.count, 0);
}
