import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // 1. Update Location Types to include 'mrb'
  pgm.dropConstraint('locations', 'chk_locations_type');
  pgm.addConstraint('locations', 'chk_locations_type', {
    check: "type IN ('warehouse','bin','store','customer','vendor','scrap','virtual','mrb')"
  });

  // 2. Create NCRs table
  pgm.createTable('ncrs', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    qc_event_id: { type: 'uuid', notNull: true, references: 'qc_events', onDelete: 'CASCADE' },
    ncr_number: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'open' },
    disposition_type: { type: 'text' },
    disposition_notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // 3. Add constraints and indexes
  pgm.addConstraint('ncrs', 'chk_ncrs_status', {
    check: "status IN ('open','closed')"
  });
  pgm.addConstraint('ncrs', 'chk_ncrs_disposition', {
    check: "disposition_type IN ('return_to_vendor','scrap','rework','use_as_is')"
  });
  
  pgm.createIndex('ncrs', ['tenant_id', 'ncr_number'], { unique: true });
  pgm.createIndex('ncrs', 'qc_event_id');
  pgm.createIndex('ncrs', 'status');

  // 4. Create sequence for NCR numbers
  pgm.createTable('ncr_sequences', {
    tenant_id: { type: 'uuid', primaryKey: true },
    next_number: { type: 'integer', notNull: true, default: 1 }
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('ncr_sequences');
  pgm.dropTable('ncrs');
  
  pgm.dropConstraint('locations', 'chk_locations_type');
  pgm.addConstraint('locations', 'chk_locations_type', {
    check: "type IN ('warehouse','bin','store','customer','vendor','scrap','virtual')"
  });
}
