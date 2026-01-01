import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create update_modified_column function
  pgm.createFunction(
    'update_modified_column',
    [],
    {
      returns: 'trigger',
      language: 'plpgsql',
    },
    `BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;`
  );

  // Create work_centers table
  pgm.createTable('work_centers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    code: { type: 'varchar(50)', notNull: true, unique: true },
    name: { type: 'varchar(100)', notNull: true },
    description: { type: 'text' },
    location_id: { type: 'uuid', references: 'locations(id)', onDelete: 'SET NULL' },
    hourly_rate: { type: 'decimal(10, 2)', default: 0 },
    capacity: { type: 'integer', default: 1 },
    status: { type: 'varchar(20)', default: 'active', notNull: true },
    created_at: { type: 'timestamptz', default: pgm.func('now()'), notNull: true },
    updated_at: { type: 'timestamptz', default: pgm.func('now()'), notNull: true }
  });

  // Create routings table
  pgm.createTable('routings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    item_id: { type: 'uuid', references: 'items(id)', onDelete: 'CASCADE', notNull: true },
    name: { type: 'varchar(100)', notNull: true },
    version: { type: 'varchar(20)', notNull: true },
    is_default: { type: 'boolean', default: false, notNull: true },
    status: { type: 'varchar(20)', default: 'draft', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', default: pgm.func('now()'), notNull: true },
    updated_at: { type: 'timestamptz', default: pgm.func('now()'), notNull: true }
  });

  // Create routing_steps table
  pgm.createTable('routing_steps', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    routing_id: { type: 'uuid', references: 'routings(id)', onDelete: 'CASCADE', notNull: true },
    sequence_number: { type: 'integer', notNull: true },
    work_center_id: { type: 'uuid', references: 'work_centers(id)', onDelete: 'RESTRICT', notNull: true },
    description: { type: 'text' },
    setup_time_minutes: { type: 'decimal(10, 2)', default: 0, notNull: true },
    run_time_minutes: { type: 'decimal(10, 2)', default: 0, notNull: true },
    machine_time_minutes: { type: 'decimal(10, 2)', default: 0, notNull: true },
    created_at: { type: 'timestamptz', default: pgm.func('now()'), notNull: true },
    updated_at: { type: 'timestamptz', default: pgm.func('now()'), notNull: true }
  });

  // Add unique constraint for routing steps sequence
  pgm.addConstraint('routing_steps', 'routing_steps_routing_id_sequence_number_key', {
    unique: ['routing_id', 'sequence_number']
  });

  // Add trigger for updated_at
  pgm.createTrigger('work_centers', 'update_work_centers_modtime', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'update_modified_column',
    level: 'ROW'
  });

  pgm.createTrigger('routings', 'update_routings_modtime', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'update_modified_column',
    level: 'ROW'
  });

  pgm.createTrigger('routing_steps', 'update_routing_steps_modtime', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'update_modified_column',
    level: 'ROW'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('routing_steps');
  pgm.dropTable('routings');
  pgm.dropTable('work_centers');
  pgm.dropFunction('update_modified_column', []);
}
