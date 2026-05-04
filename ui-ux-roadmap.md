# UI/UX Remediation Roadmap

The roadmap is ordered by corrected system risk: Critical items represent true data/traceability gaps that backend enforcement does not currently close; High items represent UI-driven operational error risk where backend protection exists or partially exists; Medium/Low items improve clarity, accessibility, and efficiency.

## Phase 0: Critical Data And Traceability Safety

### Roadmap Item 1: Make on-hand imports trace-safe

- Finding: On-hand imports do not support lot/serial fields and can be applied after validation without final stock-impact review.
- Evidence (file path, component, function): `ImportDataPage` import fields and warning at `ui/src/features/admin/pages/ImportDataPage.tsx` lines 31-34 and 208-214; apply action lines 343-349; backend import validation and apply logic in `src/routes/imports.routes.ts` lines 53-108 and `src/services/imports.service.ts` lines 422-453 and 636-693.
- Backend Invariant Status: Not Enforced. Backend rejects lot/serial columns but does not block existing lot/serial-tracked items from on-hand import when those columns are absent.
- Operational impact: Bulk imports can create on-hand stock for tracked items without lot/serial trace attributes.
- Workflow affected: Admin/config, traceability, inventory visibility, cycle counting/reconciliation.
- Severity (Critical / High / Medium / Low): Critical.
- Priority rationale: This is the only validated finding where backend enforcement does not close the core traceability/data-safety gap.
- Recommendation: Add tracked-item blocking or an exception queue, support trace fields before tracked-item import, add final apply confirmation, and show movement/count links after apply.
- Effort (S/M/L): L.
- Verification method: Import fixtures for tracked and non-tracked items; UI test requiring final apply confirmation; audit log/movement link assertion after apply.

## Phase 1: High-Risk Operator Error Prevention

### Roadmap Item 2: Require structured reasons for QC exception states

- Finding: QC hold/reject can be recorded without required operator reasons.
- Evidence (file path, component, function): `QcDetailPanel` reason field at `ui/src/features/receiving/components/QcDetailPanel.tsx` lines 225-234; `ReceivingContext` payload at lines 1014-1025; `src/schemas/qc.schema.ts` marks `reasonCode` optional.
- Backend Invariant Status: Not Enforced. Backend validates QC quantity, UOM, source, and destination roles, but does not require hold/reject reason.
- Operational impact: Exception stock states become harder to investigate and defend during quarantine/rejection or recall review.
- Workflow affected: QC, receiving, traceability.
- Severity (Critical / High / Medium / Low): High.
- Priority rationale: Backend protects balance/state transitions, but the audit reason itself is not enforced anywhere.
- Recommendation: Make reason required for QC hold/reject before mutation across detail, shortcut, and bulk paths.
- Effort (S/M/L): S.
- Verification method: RTL tests for disabled hold/reject until reason exists; payload tests showing reason is included.

### Roadmap Item 3: Replace native QC prompts with structured review modals

- Finding: QC bulk/shortcut actions rely on `window.prompt` and page-level shortcuts.
- Evidence (file path, component, function): `QcClassificationPage` prompts/shortcuts at `ui/src/features/receiving/pages/QcClassificationPage.tsx` lines 35-104; `useKeyboardShortcuts` window listener at `ui/src/features/receiving/hooks/useKeyboardShortcuts.ts` lines 37-77.
- Backend Invariant Status: Partially Enforced. Backend rejects over-QC, UOM mismatch, invalid sources, and invalid destinations, but not structured review or required reason.
- Operational impact: Operators can classify the wrong selected lines or omit meaningful exception context under time pressure.
- Workflow affected: QC, putaway.
- Severity (Critical / High / Medium / Low): High.
- Priority rationale: High-frequency QC actions can alter stock disposition; backend protects validity but not operator selection/review.
- Recommendation: Add an in-app modal listing selected lines, quantities, UOM, current QC totals, target state, and required reason; scope shortcuts to the QC workspace.
- Effort (S/M/L): M.
- Verification method: Playwright/RTL tests proving shortcuts open review and do not mutate directly.

### Roadmap Item 4: Add putaway post review before mutation

- Finding: Putaway posting can be triggered directly from the button or `Ctrl+P`.
- Evidence (file path, component, function): `PutawayPlanningPage` Ctrl+P and post button at `ui/src/features/receiving/pages/PutawayPlanningPage.tsx` lines 88-95 and 437-446; backend posting checks in `src/services/putaways.service.ts` lines 629-709.
- Backend Invariant Status: Enforced. Backend validates accepted quantity, QC availability, stock, idempotency, and replay integrity.
- Operational impact: A wrong destination can still become authoritative if the operator posts without reviewing the movement summary.
- Workflow affected: Putaway, inventory visibility.
- Severity (Critical / High / Medium / Low): High.
- Priority rationale: Backend prevents impossible stock states, but the UI should prevent valid-but-wrong destination posting.
- Recommendation: Add post confirmation with every line, source, destination, quantity, UOM, blocked/hold status, and resulting availability; require the review for `Ctrl+P`.
- Effort (S/M/L): M.
- Verification method: UI tests proving "Post putaway" opens preview first and direct shortcut cannot post without preview.

### Roadmap Item 5: Add availability panels to transfer creation

- Finding: Transfer creation does not show source availability context before post.
- Evidence (file path, component, function): `InventoryTransferCreatePage` validation/mutation at `ui/src/features/inventory/pages/InventoryTransferCreatePage.tsx` lines 67-115; `InventoryTransferForm` fields at `ui/src/features/inventory/components/InventoryTransferForm.tsx` lines 45-130.
- Backend Invariant Status: Enforced. Backend validates same-location, stock availability, negative override policy, ATP locks, idempotency, and replay.
- Operational impact: Users must discover insufficient or wrong-location stock through backend failure rather than visible guidance.
- Workflow affected: Transfers, inventory visibility.
- Severity (Critical / High / Medium / Low): High.
- Priority rationale: Backend protection is strong, but UI support reduces trial-and-error in a critical movement workflow.
- Recommendation: Display source on-hand, available, reserved/allocated, hold/quarantine, and projected remaining after transfer.
- Effort (S/M/L): M.
- Verification method: UI tests with insufficient stock fixtures and over-quantity inputs.

### Roadmap Item 6: Bound outbound shipment creation inputs

- Finding: Shipment creation uses free-text ship-from and unbounded line quantities.
- Evidence (file path, component, function): `SalesOrderDetailPage` ship-from input and line quantity fields at `ui/src/features/orderToCash/pages/SalesOrderDetailPage.tsx` lines 327-334 and 424-438; backend shipment paths in `src/schemas/orderToCash.schema.ts` lines 80-94 and `src/services/orderToCash.service.ts` lines 1733-1955 and 2038-2675.
- Backend Invariant Status: Partially Enforced. Backend validates UUID, warehouse scope, sellable ship-from, stock, and reservation state at posting; create-time demand caps were not verified in the reviewed code.
- Operational impact: Users can create misleading draft shipments or attempt quantities above demand/readiness.
- Workflow affected: Pick/pack/ship, allocation.
- Severity (Critical / High / Medium / Low): High.
- Priority rationale: Final stock posting is protected, but draft shipment errors can drive downstream work and possible over-shipment if demand caps remain absent.
- Recommendation: Replace free-text ship-from with a searchable location selector and cap/warn line quantities against open demand, reserved/allocated quantity, and available stock.
- Effort (S/M/L): M.
- Verification method: Selector interaction tests and invalid/over-quantity prevention tests.

### Roadmap Item 7: Build a traceability workspace

- Finding: No dedicated lot/serial/recall trace route is exposed.
- Evidence (file path, component, function): `ui/src/app/routeData.tsx` route list lines 1-56; backend trace support in `src/routes/compliance.routes.ts`, `src/services/compliance.service.ts`, and `src/services/lotTraceabilityEngine.ts`.
- Backend Invariant Status: Partially Enforced. Backend trace and recall capabilities exist, but no app-shell UI exposes the workflow.
- Operational impact: Recall and lot genealogy work requires manual inference across movement, receipt, QC, production, and shipment screens.
- Workflow affected: Traceability, receiving, production, shipping.
- Severity (Critical / High / Medium / Low): High.
- Priority rationale: Backend capabilities are present but operational trace execution is not discoverable as a direct workflow.
- Recommendation: Add lot/serial search, forward/backward trace, linked documents, movement lines, recall case context, and export.
- Effort (S/M/L): L.
- Verification method: End-to-end trace fixture from receipt lot to shipment.

## Phase 2: Medium Usability, Semantics, And Review Improvements

### Roadmap Item 8: Correct ATP semantics in labels and visible quantities

- Finding: ATP copy says "on-hand minus reservations" and does not surface allocated or excluded states.
- Evidence (file path, component, function): `AtpQueryPage` copy and table at `ui/src/features/inventory/pages/AtpQueryPage.tsx` lines 45-49 and 140-180; backend ATP service reads sellable availability in `src/services/atp.service.ts` lines 75-155.
- Backend Invariant Status: Enforced. Backend calculation uses the sellable availability view and includes allocated quantity.
- Operational impact: Operators may learn an unsafe mental model even though backend ATP remains authoritative.
- Workflow affected: Inventory visibility, allocation.
- Severity (Critical / High / Medium / Low): Medium.
- Priority rationale: This is a semantic clarity issue with backend protection already present.
- Recommendation: Update copy and add allocated/excluded-state explanation or columns when API data supports it.
- Effort (S/M/L): S/M depending on API data.
- Verification method: Copy and fixture tests.

### Roadmap Item 9: Add line-level count variance review before post

- Finding: Count post confirmation only shows aggregate variance.
- Evidence (file path, component, function): `InventoryCountDetailPage` post modal at `ui/src/features/inventory/pages/InventoryCountDetailPage.tsx` lines 347-368; backend reason enforcement in `src/services/counts.service.ts` lines 910-935 and 1472-1485.
- Backend Invariant Status: Enforced. Backend rejects non-zero variances without reason, requires positive-variance unit cost, and applies reconciliation policy.
- Operational impact: Operators cannot verify which items/locations will be adjusted before creating authoritative movements.
- Workflow affected: Cycle counting/reconciliation.
- Severity (Critical / High / Medium / Low): Medium.
- Priority rationale: Backend blocks incomplete adjustment posts; UI still needs a better final review surface.
- Recommendation: Add per-line variance table with book quantity, counted quantity, delta, reason, and unit cost requirement.
- Effort (S/M/L): M.
- Verification method: UI tests with variance fixtures; assert backend-required fields are visible before confirmation.

### Roadmap Item 10: Replace title-only blocked-action messaging

- Finding: Disabled reservation actions use `title` as the guard explanation.
- Evidence (file path, component, function): `ReservationsListPage` lines 228-244; `ReservationDetailPage` lines 286-320; `reservationActionPolicy` lines 20-60.
- Backend Invariant Status: Enforced. Backend rejects invalid reservation transitions.
- Operational impact: Keyboard and touch users may not learn why an action is blocked.
- Workflow affected: Allocation.
- Severity (Critical / High / Medium / Low): Medium.
- Priority rationale: This is an accessibility and recovery issue with backend protection already present.
- Recommendation: Render visible inline guard messages and associate them with disabled controls.
- Effort (S/M/L): S.
- Verification method: DOM tests for visible reason text and accessible descriptions.

### Roadmap Item 11: Add operational table sorting/filtering affordances

- Finding: Shared table primitives do not provide sorting/filtering by default.
- Evidence (file path, component, function): `ui/src/shared/ui/DataTable.tsx` props/header rendering lines 23-45 and 185-207; `ui/src/components/Table.tsx` lines 4-21.
- Backend Invariant Status: Enforced. Backend invariants are not directly affected; this is UI scanning support.
- Operational impact: Exception rows are harder to find in dense receiving, QC, reservation, shipment, and movement tables.
- Workflow affected: Shared components across receiving, QC, inventory visibility, allocation, pick/pack/ship, traceability.
- Severity (Critical / High / Medium / Low): Medium.
- Priority rationale: Improves efficiency and exception recognition after higher-risk workflow guards are addressed.
- Recommendation: Add reusable sortable headers, column filters, anomaly-first sorting, and density controls.
- Effort (S/M/L): M.
- Verification method: Component tests and page-level exception-order tests.

### Roadmap Item 12: Add purchase-order create submit confirmation

- Finding: PO creation can submit for approval without the confirmation used on the detail page.
- Evidence (file path, component, function): `PurchaseOrderCreatePage` submit button at `ui/src/features/purchaseOrders/pages/PurchaseOrderCreatePage.tsx` lines 337-343; `PurchaseOrderDetailPage` confirmation alert lines 486-507; backend readiness validation in `src/services/purchaseOrders.service.ts` lines 215-234.
- Backend Invariant Status: Enforced. Backend validates readiness before submitted/approved status.
- Operational impact: Users can commit a buying/receiving workflow without reviewing the approval/lock consequence.
- Workflow affected: Purchasing / PO creation, receiving.
- Severity (Critical / High / Medium / Low): Medium.
- Priority rationale: Workflow-commitment clarity issue with backend readiness protection.
- Recommendation: Reuse the detail-page confirmation pattern for create-page submit.
- Effort (S/M/L): S.
- Verification method: UI test that create-page submit opens confirmation before mutation and draft save remains direct.

## Phase 3: Low-Risk Configuration Usability

### Roadmap Item 13: Replace location parent raw ID with constrained selector

- Finding: Location parent field is a raw text input.
- Evidence (file path, component, function): `LocationForm` parent input at `ui/src/features/locations/components/LocationForm.tsx` lines 116-124; backend validation in `src/schemas/masterData.schema.ts` lines 81-95 and `src/routes/masterData.routes.ts` lines 209-248 and 293-324.
- Backend Invariant Status: Partially Enforced. Backend rejects malformed/nonexistent parent IDs and direct self-parent references, but cannot prevent selecting a valid wrong parent.
- Operational impact: A valid but wrong parent can create confusing warehouse hierarchy.
- Workflow affected: Admin/config, putaway, transfers, inventory visibility.
- Severity (Critical / High / Medium / Low): Low.
- Priority rationale: Backend prevents invalid references; remaining risk is configuration clarity.
- Recommendation: Use searchable selector with valid parent candidates and path preview.
- Effort (S/M/L): S.
- Verification method: Selector interaction tests and path preview tests.

## Final Verification Checklist

- All 12 requested workflows are covered in `ui-ux-route-inventory.md`.
- Every audit finding includes evidence, operational impact, workflow, severity, backend invariant status, recommendation, effort, and verification method.
- Severity separates UI-only risk from true backend/data-integrity risk.
- Critical priority is reserved for backend-unenforced data or traceability gaps.
- Unsupported visual claims were excluded; findings are based on source evidence only.
