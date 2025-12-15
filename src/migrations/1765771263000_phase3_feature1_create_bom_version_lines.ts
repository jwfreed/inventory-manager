import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('bom_version_lines', {
    id: { type: 'uuid', primaryKey: true },
    bom_version_id: {
      type: 'uuid',
      notNull: true,
      references: 'bom_versions',
      onDelete: 'CASCADE'
    },
    line_number: { type: 'integer', notNull: true },
    component_item_id: { type: 'uuid', notNull: true, references: 'items' },
    component_quantity: { type: 'numeric(18,6)', notNull: true },
    component_uom: { type: 'text', notNull: true },
    scrap_factor: { type: 'numeric(18,6)' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('bom_version_lines', 'bom_version_lines_line_unique', {
    unique: ['bom_version_id', 'line_number']
  });

  pgm.addConstraint('bom_version_lines', 'chk_bom_lines_qty_positive', {
    check: 'component_quantity > 0'
  });

  pgm.createIndex('bom_version_lines', 'bom_version_id', { name: 'idx_bom_lines_version' });
  pgm.createIndex('bom_version_lines', 'component_item_id', {
    name: 'idx_bom_lines_component_item'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('bom_version_lines');
}
