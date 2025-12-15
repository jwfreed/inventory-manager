import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('bom_versions', {
    id: { type: 'uuid', primaryKey: true },
    bom_id: { type: 'uuid', notNull: true, references: 'boms', onDelete: 'CASCADE' },
    version_number: { type: 'integer', notNull: true },
    status: { type: 'text', notNull: true },
    effective_from: { type: 'timestamptz' },
    effective_to: { type: 'timestamptz' },
    yield_quantity: { type: 'numeric(18,6)', notNull: true },
    yield_uom: { type: 'text', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('bom_versions', 'bom_versions_bom_version_number_unique', {
    unique: ['bom_id', 'version_number']
  });

  pgm.addConstraint('bom_versions', 'chk_bom_versions_status', {
    check: "status IN ('draft','active','retired')"
  });

  pgm.addConstraint('bom_versions', 'chk_bom_versions_yield_positive', {
    check: 'yield_quantity > 0'
  });

  pgm.createIndex('bom_versions', ['bom_id', 'status'], {
    name: 'idx_bom_versions_bom_status'
  });
  pgm.createIndex('bom_versions', ['effective_from', 'effective_to'], {
    name: 'idx_bom_versions_effective'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('bom_versions');
}
