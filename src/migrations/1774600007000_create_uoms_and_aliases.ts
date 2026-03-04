import type { MigrationBuilder } from 'node-pg-migrate';

const DIMENSION_CHECK = "dimension IN ('mass','length','volume','count')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('uoms', {
    code: { type: 'text', primaryKey: true },
    name: { type: 'text', notNull: true },
    dimension: { type: 'text', notNull: true },
    base_code: { type: 'text', notNull: true },
    to_base_factor: { type: 'numeric(24,12)', notNull: true },
    precision: { type: 'integer', notNull: true, default: 6 },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('uoms', 'chk_uoms_code_not_blank', "CHECK (trim(code) <> '')");
  pgm.addConstraint('uoms', 'chk_uoms_base_code_not_blank', "CHECK (trim(base_code) <> '')");
  pgm.addConstraint('uoms', 'chk_uoms_dimension', `CHECK (${DIMENSION_CHECK})`);
  pgm.addConstraint('uoms', 'chk_uoms_to_base_factor_positive', 'CHECK (to_base_factor > 0)');
  pgm.addConstraint('uoms', 'chk_uoms_precision_non_negative', 'CHECK (precision >= 0)');
  pgm.addConstraint(
    'uoms',
    'chk_uoms_base_unit_invariant',
    'CHECK (code <> base_code OR to_base_factor = 1)'
  );

  pgm.createTable('uom_aliases', {
    alias_code: { type: 'text', primaryKey: true },
    canonical_code: { type: 'text', notNull: true, references: 'uoms(code)', onDelete: 'RESTRICT' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('uom_aliases', 'chk_uom_aliases_alias_not_blank', "CHECK (trim(alias_code) <> '')");
  pgm.addConstraint(
    'uom_aliases',
    'chk_uom_aliases_canonical_not_blank',
    "CHECK (trim(canonical_code) <> '')"
  );
  pgm.addConstraint('uom_aliases', 'chk_uom_aliases_not_self', 'CHECK (alias_code <> canonical_code)');
  pgm.createIndex('uom_aliases', ['canonical_code'], { name: 'idx_uom_aliases_canonical_code' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('uom_aliases', { ifExists: true, cascade: true });
  pgm.dropTable('uoms', { ifExists: true, cascade: true });
}
