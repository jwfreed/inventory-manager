# Test Tier Classification Report

This report classifies the current repository test inventory by the tiered architecture audit.

## A. Invariant Tests

Active merge-gate invariant files:
- `tests/truth/ledger-replay-rebuild.test.mjs`
- `tests/truth/projection-rebuild-equality.test.mjs`
- `tests/truth/quantity-conservation.test.mjs`
- `tests/truth/cost-conservation.test.mjs`
- `tests/truth/ledger-immutability.test.mjs`
- `tests/truth/movement-hash-integrity.test.mjs`
- `tests/truth/idempotency-retry.test.mjs`
- `tests/truth/concurrency-item-location.test.mjs`
- `tests/truth/concurrency-license-plate.test.mjs`
- `tests/truth/mutation-shell-ordering.test.mjs`

Legacy invariant-oriented files retained outside the merge gate:
- `tests/db/inventory-invariants.test.mjs`
- `tests/db/inventory-invariants-scope-hardening.test.mjs`
- `tests/db/phase6-invariants-reservation-warehouse-historical-mismatch.test.mjs`
- `tests/db/phase6-invariants-warehouse-id-drift.test.mjs`
- `tests/ops/clean-dev-db-no-drift.test.mjs`
- `tests/ops/inventory-balance-invariants.test.mjs`
- `tests/ops/ledger-normalization-integrity.test.mjs`
- `tests/ops/ledger-reconcile.test.mjs`
- `tests/ops/ledger-system-proof.test.mjs`
- `tests/ops/license-plate-integrity.test.mjs`
- `tests/ops/movement-hash-audit.test.mjs`
- `tests/ops/strict-invariants-expanded.test.mjs`
- `tests/ops/strict-invariants-valid-topology.test.mjs`
- `tests/ops/work-order-cost-integrity.test.mjs`
- `tests/architecture/inventory-invariants-job-status.test.mjs`
- `tests/architecture/inventory-mutation-authority-guard.test.mjs`
- `tests/architecture/inventory-mutation-graph-guard.test.mjs`
- `tests/architecture/ledger-immutability-guard.test.mjs`
- `tests/architecture/ledger-immutability-role-guard.test.mjs`
- `tests/architecture/ledger-immutability-trigger-metadata.test.mjs`
- `tests/architecture/ledger-migration-lint.test.mjs`
- `tests/architecture/no-correctness-compromise-guards.test.mjs`

## B. Mutation Contract Tests

Normalized contract files:
- `tests/contracts/receive.test.mjs`
- `tests/contracts/transfer.test.mjs`
- `tests/contracts/count.test.mjs`
- `tests/contracts/adjustment.test.mjs`
- `tests/contracts/shipment.test.mjs`
- `tests/contracts/license-plate-move.test.mjs`
- `tests/contracts/work-order-issue.test.mjs`
- `tests/contracts/work-order-completion.test.mjs`
- `tests/contracts/work-order-reversal.test.mjs`

Legacy contract-oriented files retained as migration inventory:
- `tests/api/discrete-uom.test.mjs`
- `tests/api/phase0.test.mjs`
- `tests/api/uom-registry-api.test.mjs`
- `tests/api/uom-validation.test.mjs`
- `tests/api/warehouse-compatibility.test.mjs`
- `tests/api/warehouse-root-create.test.mjs`
- `tests/db/phase6-cascade-function.test.mjs`
- `tests/db/phase6-insert-derive-trigger.test.mjs`
- `tests/db/phase6-parent-update-validate-trigger.test.mjs`
- `tests/db/phase6-reparent-trigger.test.mjs`
- `tests/db/phase6-warehouse-root-schema.test.mjs`
- `tests/db/seed-siamaya-factory.test.mjs`
- `tests/db/uom-nonblank-constraints.test.mjs`
- `tests/db/uom-registry-convert.test.mjs`
- `tests/db/uom-snapshot-normalization.test.mjs`
- `tests/db/warehouse-default-invalid-repair.test.mjs`
- `tests/db/warehouse-defaults-bootstrap.test.mjs`
- `tests/ops/atp-allocated.test.mjs`
- `tests/ops/atp-cache-warehouse-scope.test.mjs`
- `tests/ops/atp-expired-lots.test.mjs`
- `tests/ops/backorders-derived.test.mjs`
- `tests/ops/cost-layer-dedupe.test.mjs`
- `tests/ops/cost-layer-immutability.test.mjs`
- `tests/ops/cycle-count-idempotency.test.mjs`
- `tests/ops/default-drift.test.mjs`
- `tests/ops/fresh-db-contract.test.mjs`
- `tests/ops/idempotency-retention-safety.test.mjs`
- `tests/ops/late-qc-commitments.test.mjs`
- `tests/ops/location-role-atp.test.mjs`
- `tests/ops/multi-warehouse-scoping.test.mjs`
- `tests/ops/negative-stock.test.mjs`
- `tests/ops/phantom-bom-cycle-detection.test.mjs`
- `tests/ops/production-areas-tenant-scoping.test.mjs`
- `tests/ops/purchase-order-lifecycle-close.test.mjs`
- `tests/ops/qc-accept-reject.test.mjs`
- `tests/ops/qc-transfer.test.mjs`
- `tests/ops/qc-transfers.test.mjs`
- `tests/ops/receipt-void-reversal.test.mjs`
- `tests/ops/receipts-cross-warehouse.test.mjs`
- `tests/ops/receipts-ledger.test.mjs`
- `tests/ops/reservations-lifecycle.test.mjs`
- `tests/ops/reservations-reconciliation.test.mjs`
- `tests/ops/reservations-sellable.test.mjs`
- `tests/ops/sales-order-warehouse-scope.test.mjs`
- `tests/ops/transactional-idempotency-cross-endpoint.test.mjs`
- `tests/ops/transactional-idempotency-helper-guards.test.mjs`
- `tests/ops/transactional-idempotency-receipts.test.mjs`
- `tests/ops/transactional-idempotency-redis-down.test.mjs`
- `tests/ops/transfer-cost-relocation.test.mjs`
- `tests/ops/warehouse-availability-unification.test.mjs`
- `tests/ops/warehouse-template-role-bin-codes.test.mjs`
- `tests/ops/warehouse-topology-seed.test.mjs`
- `tests/ops/work-order-numbering.test.mjs`
- `tests/ops/work-order-production-report.test.mjs`
- `tests/ops/work-order-report-production-routing-location.test.mjs`
- `tests/ops/work-order-report-scrap.test.mjs`
- `tests/ops/work-order-void-fails-after-qc-move.test.mjs`
- `tests/ops/work-order-void-report-production.test.mjs`
- `tests/architecture/db-reset-migrate-seed-contract-mode.test.mjs`
- `tests/architecture/fresh-db-contract-scripts.test.mjs`
- `tests/architecture/masterData-uom-error-shape.test.mjs`
- `tests/architecture/migrate-verify-target-output.test.mjs`
- `tests/architecture/shipment-conflict-shape.test.mjs`
- `tests/architecture/uom-canonical-service.test.mjs`
- `tests/architecture/warehouse-default-events-contract.test.mjs`

## C. Scenario Tests

Nightly wrappers:
- `tests/scenarios/multi-warehouse-load.test.mjs`
- `tests/scenarios/receipts-multi.test.mjs`
- `tests/scenarios/reservation-lifecycle-concurrency.test.mjs`
- `tests/scenarios/retail-distribution-flow.test.mjs`
- `tests/scenarios/transfer-idempotency.test.mjs`
- `tests/scenarios/work-order-report-production-concurrency.test.mjs`

Legacy heavy-flow files isolated behind the scenario tier:
- `tests/load/multi-warehouse-load.test.mjs`
- `tests/ops/atp-concurrency-hardening.test.mjs`
- `tests/ops/concurrency-normalization.test.mjs`
- `tests/ops/cost-layer-concurrency.test.mjs`
- `tests/ops/go-live-gates-summary-shape.test.mjs`
- `tests/ops/go-live-gates.test.mjs`
- `tests/ops/phase3-concurrency-races.test.mjs`
- `tests/ops/process-exit-cleanly.test.mjs`
- `tests/ops/purchase-order-receipt-vs-close-concurrency.test.mjs`
- `tests/ops/receipts-multi.test.mjs`
- `tests/ops/reservation-concurrency.test.mjs`
- `tests/ops/reservation-lifecycle-concurrency.test.mjs`
- `tests/ops/retail-distribution-flow.test.mjs`
- `tests/ops/transfer-idempotency.test.mjs`
- `tests/ops/work-order-report-production-concurrency.test.mjs`

## D. Brittle Tests

Source guards, topology guards, and environment guards not suitable for the merge path:
- `tests/api/00_bootstrap.test.mjs`
- `tests/architecture/atp-cache-scope-guard.test.mjs`
- `tests/architecture/atp-lock-before-availability-guard.test.mjs`
- `tests/architecture/atp-lock-ordering-guard.test.mjs`
- `tests/architecture/atp-mutation-no-cache-read-guard.test.mjs`
- `tests/architecture/atp-no-direct-advisory-lock-guard.test.mjs`
- `tests/architecture/atp-retry-budgets-startup-guard.test.mjs`
- `tests/architecture/atp-retry-budgets-startup-once.test.mjs`
- `tests/architecture/availability-math-guard.test.mjs`
- `tests/ops/atp-lock-key-derivation.test.mjs`
- `tests/architecture/bom-cycle-detector.test.mjs`
- `tests/architecture/counts-adjustments-wrapper-hardening-guard.test.mjs`
- `tests/architecture/dashboard-kpi-idempotent-read-only-guard.test.mjs`
- `tests/architecture/dashboard-kpi-uom-group-buckets.test.mjs`
- `tests/architecture/idempotency-endpoint-uniqueness-guard.test.mjs`
- `tests/architecture/no-line-side-capability-guard.test.mjs`
- `tests/architecture/no-src-imports-tests-guard.test.mjs`
- `tests/architecture/order-to-cash-wrapper-hardening-guard.test.mjs`
- `tests/architecture/picking-allocation-guard.test.mjs`
- `tests/architecture/receipts-wrapper-hardening-guard.test.mjs`
- `tests/architecture/scheduler-startup-mode-guard.test.mjs`
- `tests/architecture/test-harness-startup-contract.test.mjs`
- `tests/architecture/transfer-family-wrapper-hardening-guard.test.mjs`
- `tests/architecture/unref-usage-guard.test.mjs`
- `tests/architecture/uom-convert-architecture-guard.test.mjs`
- `tests/architecture/uom-schema-guard.test.mjs`
- `tests/architecture/uom-severity-routing-single-source-guard.test.mjs`
- `tests/architecture/warehouse-defaults-startup-mode-guard.test.mjs`

Disposition for brittle files:
- keep them available for architecture linting and migration inventory
- do not run them on every PR
- do not add new files of this shape to the truth suite

## Active Runner Disposition

Commands wired into the repository now run only the tiered directories:
- `npm run test:truth`
- `npm run test:contracts`
- `npm run test:scenarios`
- `npm run test:full`

Legacy files remain on disk for incremental migration, but they are no longer part of the active merge-gate path.
