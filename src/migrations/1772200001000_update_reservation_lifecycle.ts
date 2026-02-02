import type { MigrationBuilder } from 'node-pg-migrate';

const RESERVATION_STATUS_VALUES = "('RESERVED','ALLOCATED','CANCELLED','EXPIRED','FULFILLED')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('inventory_reservations', {
    client_id: { type: 'uuid' },
    warehouse_id: { type: 'uuid', references: 'locations' },
    expires_at: { type: 'timestamptz' },
    cancel_reason: { type: 'text' },
    allocated_at: { type: 'timestamptz' },
    canceled_at: { type: 'timestamptz' },
    fulfilled_at: { type: 'timestamptz' },
    expired_at: { type: 'timestamptz' },
  });

  pgm.sql(
    `UPDATE inventory_reservations
        SET client_id = tenant_id
      WHERE client_id IS NULL;`
  );

  pgm.sql(
    `UPDATE inventory_reservations
        SET warehouse_id = resolve_warehouse_for_location(tenant_id, location_id)
      WHERE warehouse_id IS NULL;`
  );

  pgm.sql(
    `UPDATE inventory_reservations
        SET status = CASE
          WHEN status = 'open' THEN 'RESERVED'
          WHEN status = 'released' THEN 'ALLOCATED'
          WHEN status = 'fulfilled' THEN 'FULFILLED'
          WHEN status = 'canceled' THEN 'CANCELLED'
          ELSE status
        END,
        allocated_at = CASE WHEN status = 'released' AND allocated_at IS NULL THEN COALESCE(released_at, now()) ELSE allocated_at END,
        fulfilled_at = CASE WHEN status = 'fulfilled' AND fulfilled_at IS NULL THEN COALESCE(released_at, now()) ELSE fulfilled_at END,
        canceled_at = CASE WHEN status = 'canceled' AND canceled_at IS NULL THEN COALESCE(updated_at, now()) ELSE canceled_at END;`
  );

  pgm.alterColumn('inventory_reservations', 'client_id', { notNull: true });

  pgm.dropConstraint('inventory_reservations', 'chk_reservation_status', { ifExists: true });
  pgm.addConstraint('inventory_reservations', 'chk_reservation_status', {
    check: `status IN ${RESERVATION_STATUS_VALUES}`,
  });

  pgm.dropConstraint('inventory_reservations', 'uq_inventory_reservations_idempotency', { ifExists: true });
  pgm.createIndex('inventory_reservations', ['client_id', 'idempotency_key'], {
    name: 'uq_inventory_reservations_idempotency_client',
    unique: true,
    where: 'idempotency_key IS NOT NULL',
  });

  pgm.createTable('reservation_events', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    reservation_id: { type: 'uuid', notNull: true, references: 'inventory_reservations', onDelete: 'CASCADE' },
    event_type: { type: 'text', notNull: true },
    delta_reserved: { type: 'numeric(18,6)', notNull: true, default: 0 },
    delta_allocated: { type: 'numeric(18,6)', notNull: true, default: 0 },
    occurred_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('reservation_events', 'chk_reservation_event_type', {
    check: "event_type IN ('RESERVED','ALLOCATED','CANCELLED','EXPIRED','FULFILLED')",
  });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_reservation_status_transition()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF OLD.status IN ('CANCELLED','EXPIRED','FULFILLED') AND NEW.status <> OLD.status THEN
          RAISE EXCEPTION 'RESERVATION_TERMINAL_STATE';
        END IF;

        IF OLD.status = 'RESERVED' AND NEW.status NOT IN ('RESERVED','ALLOCATED','CANCELLED','EXPIRED') THEN
          RAISE EXCEPTION 'RESERVATION_INVALID_TRANSITION';
        END IF;

        IF OLD.status = 'ALLOCATED' AND NEW.status NOT IN ('ALLOCATED','FULFILLED','CANCELLED') THEN
          RAISE EXCEPTION 'RESERVATION_INVALID_TRANSITION';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_reservation_status_transition ON inventory_reservations;
    CREATE TRIGGER trg_reservation_status_transition
      BEFORE UPDATE OF status ON inventory_reservations
      FOR EACH ROW
      EXECUTE FUNCTION enforce_reservation_status_transition();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TRIGGER IF EXISTS trg_reservation_status_transition ON inventory_reservations;');
  pgm.sql('DROP FUNCTION IF EXISTS enforce_reservation_status_transition();');
  pgm.dropTable('reservation_events', { ifExists: true });
  pgm.dropIndex('inventory_reservations', 'uq_inventory_reservations_idempotency_client', { ifExists: true });
  pgm.addConstraint('inventory_reservations', 'chk_reservation_status', {
    check: "status IN ('open','released','fulfilled','canceled')",
  });
  pgm.addConstraint('inventory_reservations', 'uq_inventory_reservations_idempotency', {
    unique: ['tenant_id', 'idempotency_key'],
  });
  pgm.dropColumns('inventory_reservations', [
    'client_id',
    'warehouse_id',
    'expires_at',
    'cancel_reason',
    'allocated_at',
    'canceled_at',
    'fulfilled_at',
    'expired_at',
  ], { ifExists: true });
}
