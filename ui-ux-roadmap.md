# UI/UX Remediation Roadmap

The roadmap is ordered by inventory corruption risk, operator error likelihood, and implementation dependency.

## Phase 0: Immediate Safety Stops

### Roadmap Item 1: Require structured reasons for exception-state mutations

- Finding: QC hold/reject and count variance lines can proceed without required operator reasons.
- Evidence (file path, component, function): `QcDetailPanel` reason field at `ui/src/features/receiving/components/QcDetailPanel.tsx` lines 225-234; `ReceivingContext` payload at lines 1014-1025; `InventoryCountForm` reason field at `ui/src/features/inventory/components/InventoryCountForm.tsx` lines 200-206.
- Operational impact: Exception stock states and adjustments become harder to investigate and audit.
- Workflow affected: QC, cycle counting/reconciliation, traceability.
- Severity (Critical / High / Medium / Low): Critical.
- Recommendation: Make reason required for QC hold/reject and count variance lines before mutation/confirmation.
- Effort (S/M/L): S.
- Verification method: RTL tests for disabled actions until reason exists; payload tests showing reason is included.

### Roadmap Item 2: Replace native prompts and one-step posting with in-app confirmation modals

- Finding: QC bulk/shortcut actions and putaway posting can mutate stock state without a structured review.
- Evidence (file path, component, function): `QcClassificationPage` prompts/shortcuts at `ui/src/features/receiving/pages/QcClassificationPage.tsx` lines 35-104; `PutawayPlanningPage` Ctrl+P and post button at `ui/src/features/receiving/pages/PutawayPlanningPage.tsx` lines 88-95 and 437-446.
- Operational impact: Wrong selected lines or destinations can be committed before the user reviews item, quantity, UOM, source, destination, and blocked states.
- Workflow affected: QC, putaway.
- Severity (Critical / High / Medium / Low): Critical.
- Recommendation: Add shared high-risk confirmation modal with mutation preview and require it for bulk QC and putaway posting.
- Effort (S/M/L): M.
- Verification method: Playwright/RTL tests proving shortcuts open review but do not mutate directly.

### Roadmap Item 3: Add line-level count variance review before post

- Finding: Count post confirmation only shows aggregate variance.
- Evidence (file path, component, function): `InventoryCountDetailPage` post modal at `ui/src/features/inventory/pages/InventoryCountDetailPage.tsx` lines 347-368.
- Operational impact: Operators cannot verify which items/locations will be adjusted before creating authoritative movements.
- Workflow affected: Cycle counting/reconciliation.
- Severity (Critical / High / Medium / Low): Critical.
- Recommendation: Add per-line variance table with book quantity, counted quantity, delta, reason, and unit cost requirement.
- Effort (S/M/L): M.
- Verification method: UI tests with variance fixtures; confirm disabled until every required line is complete.

## Phase 1: Prevent Wrong Operational Inputs

### Roadmap Item 4: Add availability panels to transfer and outbound shipment creation

- Finding: Transfer and shipment creation screens do not show enough source availability context before mutation.
- Evidence (file path, component, function): `InventoryTransferCreatePage` validation/mutation at `ui/src/features/inventory/pages/InventoryTransferCreatePage.tsx` lines 67-115; `SalesOrderDetailPage` shipment gating and inputs at `ui/src/features/orderToCash/pages/SalesOrderDetailPage.tsx` lines 196-201 and 424-438.
- Operational impact: Users can attempt moves or shipments from the wrong location or for quantities above usable stock.
- Workflow affected: Transfers, allocation, pick/pack/ship.
- Severity (Critical / High / Medium / Low): Critical.
- Recommendation: Display source on-hand, available, reserved/allocated, hold/quarantine, and projected remaining; bound shipment quantities by open demand and readiness.
- Effort (S/M/L): M.
- Verification method: UI tests with insufficient stock fixtures and over-quantity inputs.

### Roadmap Item 5: Replace raw ID fields with constrained selectors

- Finding: Sales order shipment ship-from and location parent fields are raw text inputs.
- Evidence (file path, component, function): `SalesOrderDetailPage` ship-from input at `ui/src/features/orderToCash/pages/SalesOrderDetailPage.tsx` lines 327-334; `LocationForm` parent input at `ui/src/features/locations/components/LocationForm.tsx` lines 116-124.
- Operational impact: Mistyped IDs can create bad draft shipments or confusing warehouse hierarchy.
- Workflow affected: Pick/pack/ship, admin/config, putaway, transfers.
- Severity (Critical / High / Medium / Low): Medium.
- Recommendation: Use searchable selectors with valid options, path previews, and typed blocked-state messages.
- Effort (S/M/L): S.
- Verification method: Selector interaction tests and invalid ID prevention tests.

### Roadmap Item 6: Correct ATP semantics in labels and visible quantities

- Finding: ATP copy says "on-hand minus reservations" and does not surface excluded states.
- Evidence (file path, component, function): `AtpQueryPage` copy and table at `ui/src/features/inventory/pages/AtpQueryPage.tsx` lines 45-49 and 140-180.
- Operational impact: Operators may treat held, blocked, or in-transit stock as promiseable.
- Workflow affected: Inventory visibility, allocation.
- Severity (Critical / High / Medium / Low): High.
- Recommendation: Update copy and add excluded-state explanation or columns when API data supports it.
- Effort (S/M/L): S/M depending on API data.
- Verification method: Copy and fixture tests.

## Phase 2: Traceability And Bulk Admin Safety

### Roadmap Item 7: Build a traceability workspace

- Finding: No dedicated lot/serial/recall trace route is exposed.
- Evidence (file path, component, function): `ui/src/app/routeData.tsx` route list lines 1-56; backend trace support in `src/services/compliance.service.ts` and `src/services/lotTraceabilityEngine.ts`.
- Operational impact: Recall and lot genealogy work requires manual inference across movement, receipt, QC, production, and shipment screens.
- Workflow affected: Traceability, receiving, production, shipping.
- Severity (Critical / High / Medium / Low): High.
- Recommendation: Add lot/serial search, forward/backward trace, linked documents, movement lines, and export.
- Effort (S/M/L): L.
- Verification method: End-to-end trace fixture from receipt lot to shipment.

### Roadmap Item 8: Make on-hand imports trace-safe

- Finding: On-hand imports do not support lot/serial fields and can be applied after validation without final stock-impact review.
- Evidence (file path, component, function): `ImportDataPage` import fields and warning at `ui/src/features/admin/pages/ImportDataPage.tsx` lines 31-34 and 208-214; apply action lines 343-349.
- Operational impact: Bulk imports can create untraceable stock for tracked items.
- Workflow affected: Admin/config, traceability, inventory visibility.
- Severity (Critical / High / Medium / Low): Critical.
- Recommendation: Add tracked-item blocking/exception queue, final apply confirmation, and movement/audit links after apply.
- Effort (S/M/L): L.
- Verification method: Import fixtures for tracked and non-tracked items.

## Phase 3: Scannability And Accessibility

### Roadmap Item 9: Replace title-only blocked-action messaging

- Finding: Disabled reservation actions use `title` as the guard explanation.
- Evidence (file path, component, function): `ReservationsListPage` lines 228-244; `ReservationDetailPage` lines 286-320.
- Operational impact: Keyboard and touch users may not learn why an action is blocked.
- Workflow affected: Allocation.
- Severity (Critical / High / Medium / Low): Medium.
- Recommendation: Render visible inline guard messages and associate them with disabled controls.
- Effort (S/M/L): S.
- Verification method: DOM tests for visible reason text and accessible descriptions.

### Roadmap Item 10: Add operational table sorting/filtering affordances

- Finding: Shared table primitives do not provide sorting/filtering by default.
- Evidence (file path, component, function): `ui/src/shared/ui/DataTable.tsx` props/header rendering lines 23-45 and 185-207; `ui/src/components/Table.tsx` lines 4-21.
- Operational impact: Exception rows are harder to find in dense receiving, QC, reservation, shipment, and movement tables.
- Workflow affected: Shared components across receiving, QC, inventory visibility, allocation, pick/pack/ship, traceability.
- Severity (Critical / High / Medium / Low): Medium.
- Recommendation: Add reusable sortable headers, column filters, anomaly-first sorting, and density controls.
- Effort (S/M/L): M.
- Verification method: Component tests and page-level exception-order tests.

## Final Verification Checklist

- All 12 requested workflows are covered in `ui-ux-route-inventory.md`.
- Every audit finding includes evidence, operational impact, workflow, severity, recommendation, effort, and verification method.
- Severity is reserved for inventory-state corruption risk, auditability loss, or high-probability operator error.
- Unsupported visual claims were excluded; findings are based on source evidence only.
