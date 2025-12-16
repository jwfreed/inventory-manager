import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('work_order_material_issue_lines', {
    id: { type: 'uuid', primaryKey: true },
    work_order_material_issue_id: {
      type: 'uuid',
      notNull: true,
      references: 'work_order_material_issues',
      onDelete: 'CASCADE'
    },
    line_number: { type: 'integer', notNull: true },
    component_item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    quantity_issued: { type: 'numeric(18,6)', notNull: true },
    from_location_id: { type: 'uuid', notNull: true, references: 'locations' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('work_order_material_issue_lines', 'work_order_material_issue_lines_line_unique', {
    unique: ['work_order_material_issue_id', 'line_number']
  });

  pgm.addConstraint('work_order_material_issue_lines', 'chk_womi_lines_quantity', {
    check: 'quantity_issued > 0'
  });

  pgm.createIndex('work_order_material_issue_lines', 'work_order_material_issue_id', {
    name: 'idx_womi_lines_issue_id'
  });
  pgm.createIndex('work_order_material_issue_lines', 'component_item_id', {
    name: 'idx_womi_lines_component_item'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('work_order_material_issue_lines');
}
