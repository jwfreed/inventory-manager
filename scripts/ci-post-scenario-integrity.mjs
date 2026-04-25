#!/usr/bin/env node
/**
 * CI Post-Scenario Integrity Validator
 *
 * Validates inventory system invariants after scenario tests complete.
 * This is NOT a test — it validates real database state for correctness
 * after a realistic workload has executed.
 *
 * Exit codes:
 *   0 = all invariants pass
 *   1 = script error (connection failure, missing config)
 *   2 = invariant violation detected
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('[integrity] DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
  lock_timeout: 5000
});

const violations = [];
let checksRun = 0;

const unitEventCoverageExceptionClauses = [];

function report(name, count, rows) {
  checksRun += 1;
  if (count > 0) {
    violations.push({ name, count, sample: rows.slice(0, 10) });
    console.error(`[FAIL] ${name}: ${count} violation(s)`);
    for (const row of rows.slice(0, 5)) {
      console.error(`       ${JSON.stringify(row)}`);
    }
  } else {
    console.log(`[PASS] ${name}`);
  }
}

try {
  // ────────────────────────────────────────────────────────
  // 0. Discover tenants — fail if database is empty
  //    Scenarios are expected to create data. Zero tenants
  //    means the CI setup or scenario execution is broken.
  // ────────────────────────────────────────────────────────
  const tenantsRes = await pool.query('SELECT id FROM tenants');
  const tenantIds = tenantsRes.rows.map((r) => r.id);
  if (tenantIds.length === 0) {
    console.error('[integrity] FAIL: No tenants found. Scenarios should have created data — this indicates a broken CI setup or failed scenario execution.');
    process.exit(2);
  }
  console.log(`[integrity] Found ${tenantIds.length} tenant(s). Running invariant checks...\n`);

  // ────────────────────────────────────────────────────────
  // 1. AUTHORITY-COMPATIBILITY RECONCILIATION
  //    inventory_balance is a compatibility projection. It must
  //    match the authoritative ledger/reservation availability view
  //    for each (tenant, item, location, uom) tuple.
  // ────────────────────────────────────────────────────────
  const ledgerReconcileRes = await pool.query(`
    WITH authority AS (
      SELECT tenant_id,
             item_id,
             location_id,
             uom,
             SUM(on_hand_qty) AS on_hand,
             SUM(reserved_qty) AS reserved,
             SUM(allocated_qty) AS allocated
        FROM inventory_available_location_v
       GROUP BY tenant_id, item_id, location_id, uom
    )
    SELECT b.tenant_id,
           b.item_id,
           b.location_id,
           b.uom,
           b.on_hand AS balance_on_hand,
           COALESCE(a.on_hand, 0) AS authority_on_hand,
           b.reserved AS balance_reserved,
           COALESCE(a.reserved, 0) AS authority_reserved,
           b.allocated AS balance_allocated,
           COALESCE(a.allocated, 0) AS authority_allocated,
           b.on_hand - COALESCE(a.on_hand, 0) AS on_hand_drift,
           b.reserved - COALESCE(a.reserved, 0) AS reserved_drift,
           b.allocated - COALESCE(a.allocated, 0) AS allocated_drift
      FROM inventory_balance b
      LEFT JOIN authority a
        ON a.tenant_id = b.tenant_id
       AND a.item_id = b.item_id
       AND a.location_id = b.location_id
       AND a.uom = b.uom
     WHERE ABS(b.on_hand - COALESCE(a.on_hand, 0)) > 0.0001
        OR ABS(b.reserved - COALESCE(a.reserved, 0)) > 0.0001
        OR ABS(b.allocated - COALESCE(a.allocated, 0)) > 0.0001
     LIMIT 50
  `);
  report(
    'compatibility_balance_reconciliation',
    ledgerReconcileRes.rowCount ?? 0,
    ledgerReconcileRes.rows
  );

  // Also check for authoritative rows with no balance projection row
  const orphanedLedgerRes = await pool.query(`
    WITH authority AS (
      SELECT tenant_id,
             item_id,
             location_id,
             uom,
             SUM(on_hand_qty) AS on_hand,
             SUM(reserved_qty) AS reserved,
             SUM(allocated_qty) AS allocated
        FROM inventory_available_location_v
       GROUP BY tenant_id, item_id, location_id, uom
      HAVING ABS(SUM(on_hand_qty)) > 0.0001
          OR ABS(SUM(reserved_qty)) > 0.0001
          OR ABS(SUM(allocated_qty)) > 0.0001
    )
    SELECT a.tenant_id,
           a.item_id,
           a.location_id,
           a.uom,
           a.on_hand AS authority_on_hand,
           a.reserved AS authority_reserved,
           a.allocated AS authority_allocated
      FROM authority a
      LEFT JOIN inventory_balance b
        ON b.tenant_id = a.tenant_id
       AND b.item_id = a.item_id
       AND b.location_id = a.location_id
       AND b.uom = a.uom
     WHERE b.tenant_id IS NULL
     LIMIT 50
  `);
  report(
    'authority_rows_missing_compatibility_balance',
    orphanedLedgerRes.rowCount ?? 0,
    orphanedLedgerRes.rows
  );

  // ────────────────────────────────────────────────────────
  // 2. NO NEGATIVE BALANCES
  //    on_hand, reserved, allocated must all be >= 0
  // ────────────────────────────────────────────────────────
  const negativeBalanceRes = await pool.query(`
    SELECT tenant_id, item_id, location_id, uom,
           on_hand, reserved, allocated
      FROM inventory_balance
     WHERE on_hand < 0
        OR reserved < 0
        OR allocated < 0
     LIMIT 50
  `);
  report(
    'no_negative_balances',
    negativeBalanceRes.rowCount ?? 0,
    negativeBalanceRes.rows
  );

  // ────────────────────────────────────────────────────────
  // 3. STATE RELATIONSHIPS
  //    reserved + allocated must not exceed on_hand.
  //    Equivalently: available (on_hand - reserved - allocated) >= 0.
  // ────────────────────────────────────────────────────────
  const stateRelationRes = await pool.query(`
    SELECT tenant_id, item_id, location_id, uom,
           on_hand_qty AS on_hand,
           reserved_qty AS reserved,
           allocated_qty AS allocated,
           available_qty AS available
      FROM inventory_available_location_v
     WHERE (reserved_qty + allocated_qty) > on_hand_qty + 0.0001
     LIMIT 50
  `);
  report(
    'state_relationship_reserved_plus_allocated_lte_on_hand',
    stateRelationRes.rowCount ?? 0,
    stateRelationRes.rows
  );

  // ────────────────────────────────────────────────────────
  // 4. POSTED MOVEMENT COMPLETENESS
  //    Every posted movement must have at least one line
  // ────────────────────────────────────────────────────────
  const movementCompletenessRes = await pool.query(`
    SELECT im.id, im.tenant_id, im.movement_type, im.status, im.created_at
      FROM inventory_movements im
      LEFT JOIN inventory_movement_lines iml
        ON iml.movement_id = im.id
       AND iml.tenant_id = im.tenant_id
     WHERE im.status = 'posted'
       AND iml.id IS NULL
     LIMIT 50
  `);
  report(
    'posted_movement_completeness_has_lines',
    movementCompletenessRes.rowCount ?? 0,
    movementCompletenessRes.rows
  );

  // ────────────────────────────────────────────────────────
  // 5. MOVEMENT LINE UNIT-EVENT COVERAGE
  //    Every posted movement line must append at least one
  //    inventory_unit_event. No production movement types are exempt.
  // ────────────────────────────────────────────────────────
  const unitEventCoverageExceptionSql = unitEventCoverageExceptionClauses.length > 0
    ? `AND NOT (${unitEventCoverageExceptionClauses.join(' OR ')})`
    : '';
  const unitEventCoverageRes = await pool.query(`
    SELECT im.tenant_id,
           im.id AS movement_id,
           im.movement_type,
           im.source_type,
           im.source_id,
           iml.id AS movement_line_id,
           iml.source_line_id,
           iml.reason_code,
           iml.item_id,
           iml.location_id,
           COALESCE(iml.canonical_uom, iml.uom) AS uom,
           COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) AS quantity_delta,
           'posted_movement_line_missing_unit_event' AS classification
      FROM inventory_movements im
      JOIN inventory_movement_lines iml
        ON iml.movement_id = im.id
       AND iml.tenant_id = im.tenant_id
     WHERE im.status = 'posted'
       AND NOT EXISTS (
         SELECT 1
           FROM inventory_unit_events iue
          WHERE iue.tenant_id = iml.tenant_id
            AND iue.movement_line_id = iml.id
       )
       ${unitEventCoverageExceptionSql}
     LIMIT 50
  `);
  report(
    'posted_movement_line_unit_event_coverage',
    unitEventCoverageRes.rowCount ?? 0,
    unitEventCoverageRes.rows
  );

  // ────────────────────────────────────────────────────────
  // 6. MOVEMENT LINE INTEGRITY
  //    Every movement line must reference a valid movement
  // ────────────────────────────────────────────────────────
  const lineIntegrityRes = await pool.query(`
    SELECT iml.id, iml.tenant_id, iml.movement_id
      FROM inventory_movement_lines iml
      LEFT JOIN inventory_movements im
        ON im.id = iml.movement_id
       AND im.tenant_id = iml.tenant_id
     WHERE im.id IS NULL
     LIMIT 50
  `);
  report(
    'movement_line_references_valid_movement',
    lineIntegrityRes.rowCount ?? 0,
    lineIntegrityRes.rows
  );

  // ────────────────────────────────────────────────────────
  // 7. TRANSACTION TRACEABILITY
  //    Every movement must have a non-null, non-empty
  //    movement_type AND external_ref for auditability.
  // ────────────────────────────────────────────────────────
  const traceabilityRes = await pool.query(`
    SELECT id, tenant_id, movement_type, external_ref, created_at
      FROM inventory_movements
     WHERE movement_type IS NULL
        OR movement_type = ''
        OR external_ref IS NULL
        OR external_ref = ''
     LIMIT 50
  `);
  report(
    'transaction_traceability_movement_type_and_external_ref',
    traceabilityRes.rowCount ?? 0,
    traceabilityRes.rows
  );

  // ────────────────────────────────────────────────────────
  // 8. HASH INTEGRITY
  //    Non-legacy movements should have deterministic hashes
  // ────────────────────────────────────────────────────────
  const hashIntegrityRes = await pool.query(`
    SELECT id, tenant_id, movement_type, status, created_at
      FROM inventory_movements
     WHERE movement_deterministic_hash IS NULL
       AND status NOT IN ('voided', 'reversed')
       AND created_at > (now() - interval '1 day')
     LIMIT 50
  `);
  report(
    'hash_integrity_recent_movements',
    hashIntegrityRes.rowCount ?? 0,
    hashIntegrityRes.rows
  );

  // ────────────────────────────────────────────────────────
  // 9. RESERVATION BOUNDS
  //    Active reservations should have valid quantities
  // ────────────────────────────────────────────────────────
  const hasReservationsTable = await pool.query(`
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'inventory_reservations'
     LIMIT 1
  `);
  if ((hasReservationsTable.rowCount ?? 0) > 0) {
    const reservationBoundsRes = await pool.query(`
      SELECT id, tenant_id, item_id, location_id, uom, status,
             quantity_reserved,
             COALESCE(quantity_fulfilled, 0) AS quantity_fulfilled
        FROM inventory_reservations
       WHERE quantity_reserved < 0
          OR COALESCE(quantity_fulfilled, 0) < 0
          OR COALESCE(quantity_fulfilled, 0) > quantity_reserved
       LIMIT 50
    `);
    report(
      'reservation_quantity_bounds',
      reservationBoundsRes.rowCount ?? 0,
      reservationBoundsRes.rows
    );

    // Check orphaned reservations — FULFILLED reservations that committed
    // against an item/location/uom with no inventory_balance row.
    // RESERVED and ALLOCATED may temporarily exist before balance is
    // projected, so only FULFILLED (which implies stock was consumed)
    // is a hard invariant violation here.
    const orphanedReservationRes = await pool.query(`
      SELECT r.id, r.tenant_id, r.item_id, r.location_id, r.uom,
             r.status, r.quantity_reserved,
             COALESCE(r.quantity_fulfilled, 0) AS quantity_fulfilled
        FROM inventory_reservations r
        LEFT JOIN inventory_balance b
          ON b.tenant_id = r.tenant_id
         AND b.item_id = r.item_id
         AND b.location_id = r.location_id
         AND b.uom = r.uom
       WHERE r.status = 'FULFILLED'
         AND COALESCE(r.quantity_fulfilled, 0) > 0
         AND b.tenant_id IS NULL
       LIMIT 50
    `);
    report(
      'no_orphaned_fulfilled_reservations',
      orphanedReservationRes.rowCount ?? 0,
      orphanedReservationRes.rows
    );
  } else {
    console.log('[SKIP] reservation checks — table not present');
  }

  // ────────────────────────────────────────────────────────
  // 10. IDEMPOTENCY KEY UNIQUENESS
  //    No two non-voided movements share the same idempotency_key
  // ────────────────────────────────────────────────────────
  const idempotencyRes = await pool.query(`
    SELECT tenant_id, idempotency_key, COUNT(*)::int AS cnt
      FROM inventory_movements
     WHERE idempotency_key IS NOT NULL
       AND status NOT IN ('voided', 'reversed')
     GROUP BY tenant_id, idempotency_key
    HAVING COUNT(*) > 1
     LIMIT 50
  `);
  report(
    'idempotency_key_uniqueness',
    idempotencyRes.rowCount ?? 0,
    idempotencyRes.rows
  );

  // ────────────────────────────────────────────────────────
  // 11. CONSERVATION PER-TENANT (cross-check)
  //     Total ledger net by tenant should equal total balance net
  // ────────────────────────────────────────────────────────
  const conservationRes = await pool.query(`
    WITH ledger_totals AS (
      SELECT tenant_id,
             SUM(on_hand_qty) AS total_ledger
        FROM inventory_available_location_v
       GROUP BY tenant_id
    ),
    balance_totals AS (
      SELECT tenant_id,
             SUM(on_hand) AS total_balance
        FROM inventory_balance
       GROUP BY tenant_id
    )
    SELECT COALESCE(lt.tenant_id, bt.tenant_id) AS tenant_id,
           COALESCE(lt.total_ledger, 0) AS total_ledger,
           COALESCE(bt.total_balance, 0) AS total_balance,
           COALESCE(bt.total_balance, 0) - COALESCE(lt.total_ledger, 0) AS drift
      FROM ledger_totals lt
      FULL OUTER JOIN balance_totals bt
        ON bt.tenant_id = lt.tenant_id
     WHERE ABS(COALESCE(bt.total_balance, 0) - COALESCE(lt.total_ledger, 0)) > 0.01
  `);
  report(
    'conservation_per_tenant',
    conservationRes.rowCount ?? 0,
    conservationRes.rows
  );

  // ────────────────────────────────────────────────────────
  // SUMMARY
  // ────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[integrity] ${checksRun} checks executed.`);

  if (violations.length > 0) {
    console.error(`[integrity] ${violations.length} INVARIANT VIOLATION(S) DETECTED:`);
    for (const v of violations) {
      console.error(`  - ${v.name}: ${v.count} violation(s)`);
    }
    console.error(
      `\n[integrity] RESULT: FAIL — inventory state is corrupt after scenario execution.`
    );
    console.error(
      JSON.stringify({ event: 'ci_integrity_failure', violations: violations.map((v) => ({ name: v.name, count: v.count })) })
    );
    process.exit(2);
  } else {
    console.log(`[integrity] RESULT: PASS — all inventory invariants hold.`);
    process.exit(0);
  }
} catch (error) {
  console.error('[integrity] Script error:', error);
  process.exit(1);
} finally {
  await pool.end();
}
