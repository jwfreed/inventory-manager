import type { MigrationBuilder } from 'node-pg-migrate';

const JOB_STATUS = "('uploaded','validated','queued','processing','completed','failed')";
const ROW_STATUS = "('pending','valid','error','applied','skipped')";
const JOB_TYPE = "('items','locations','on_hand')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('import_jobs', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    type: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'uploaded' },
    file_name: { type: 'text' },
    source_csv: { type: 'text' },
    mapping: { type: 'jsonb' },
    total_rows: { type: 'integer', notNull: true, default: 0 },
    valid_rows: { type: 'integer', notNull: true, default: 0 },
    error_rows: { type: 'integer', notNull: true, default: 0 },
    counted_at: { type: 'timestamptz' },
    error_summary: { type: 'text' },
    created_by: { type: 'uuid', notNull: true, references: 'users', onDelete: 'RESTRICT' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    started_at: { type: 'timestamptz' },
    finished_at: { type: 'timestamptz' }
  });

  pgm.addConstraint('import_jobs', 'chk_import_jobs_status', {
    check: `status IN ${JOB_STATUS}`
  });

  pgm.addConstraint('import_jobs', 'chk_import_jobs_type', {
    check: `type IN ${JOB_TYPE}`
  });

  pgm.createIndex('import_jobs', ['tenant_id', 'created_at'], { name: 'idx_import_jobs_tenant_created' });
  pgm.createIndex('import_jobs', ['tenant_id', 'status'], { name: 'idx_import_jobs_tenant_status' });

  pgm.createTable('import_job_rows', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    job_id: { type: 'uuid', notNull: true, references: 'import_jobs', onDelete: 'CASCADE' },
    row_number: { type: 'integer', notNull: true },
    raw: { type: 'jsonb', notNull: true },
    normalized: { type: 'jsonb' },
    status: { type: 'text', notNull: true, default: 'pending' },
    error_code: { type: 'text' },
    error_detail: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('import_job_rows', 'chk_import_job_rows_status', {
    check: `status IN ${ROW_STATUS}`
  });

  pgm.addConstraint('import_job_rows', 'uq_import_job_rows_row', {
    unique: ['job_id', 'row_number']
  });

  pgm.createIndex('import_job_rows', ['job_id', 'status'], { name: 'idx_import_job_rows_job_status' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('import_job_rows');
  pgm.dropTable('import_jobs');
}
