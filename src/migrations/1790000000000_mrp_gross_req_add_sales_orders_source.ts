import type { MigrationBuilder } from 'node-pg-migrate';

// Extend mrp_gross_requirements.source_type to include 'sales_orders'.
// This allows loadSalesOrderDemandIntoRun() to populate demand directly
// from open sales order lines without requiring manual mps/bom_explosion entries.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('mrp_gross_requirements', 'chk_mrp_gross_req_type');
  pgm.addConstraint('mrp_gross_requirements', 'chk_mrp_gross_req_type', {
    check: "source_type IN ('mps','bom_explosion','sales_orders')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('mrp_gross_requirements', 'chk_mrp_gross_req_type');
  pgm.addConstraint('mrp_gross_requirements', 'chk_mrp_gross_req_type', {
    check: "source_type IN ('mps','bom_explosion')",
  });
}
