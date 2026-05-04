# UI/UX Audit

Audit scope: source inspection of React UI routes, shared UI components, and domain invariant documentation. No visual screenshot claims are made.

## Finding 1: QC hold/reject can be recorded without a required reason

- Finding: The QC detail form labels hold/reject reason code as optional, and `canRecordQc` is based on selected line, remaining quantity, and quantity validity rather than reason presence. The context sends `reasonCode` only when trimmed.
- Evidence (file path, component, function): `ui/src/features/receiving/components/QcDetailPanel.tsx`, `QcDetailPanel`, lines 225-234 label "Reason code (optional)" for hold/reject; `ui/src/features/receiving/context/ReceivingContext.tsx`, `canRecordQc` and `onCreateQcEvent`, lines 639-641 and 1014-1025.
- Operational impact: Operators can move received stock into hold or reject states without an auditable reason, weakening quarantine/rejection investigation and recall defensibility.
- Workflow affected: QC (accept / reject / hold), receiving, traceability.
- Severity (Critical / High / Medium / Low): Critical.
- Recommendation: Require reason code for `hold` and `reject`; keep `accept` reason optional. Show inline validation before enabling "Record QC" and apply the same rule to keyboard and bulk paths.
- Effort (S/M/L): S.
- Verification method: Unit/UI test for hold/reject disabled until reason exists; keyboard shortcut and bulk-action tests; API payload assertion that hold/reject sends reason.

## Finding 2: QC bulk and keyboard actions rely on native prompts and shortcuts for high-impact state changes

- Finding: Bulk hold/reject and keyboard hold/reject use `window.prompt`; quick accept uses the `A` shortcut to accept all remaining quantity on the selected line. Native prompts do not show line summaries, quantities, UOM, existing hold/reject state, or structured validation.
- Evidence (file path, component, function): `ui/src/features/receiving/pages/QcClassificationPage.tsx`, `handleBulkAction` lines 35-49; keyboard shortcuts lines 55-104; `ui/src/features/receiving/components/QcDetailPanel.tsx`, quick accept lines 131-147.
- Operational impact: A time-pressured operator can bulk-classify or accept the wrong selected lines with little review context. This can make uninspected or defective stock eligible for putaway or remove usable stock from flow.
- Workflow affected: QC (accept / reject / hold), putaway.
- Severity (Critical / High / Medium / Low): Critical.
- Recommendation: Replace prompts with an application modal that lists selected receipt lines, item, quantity, UOM, current QC totals, destination state, required reason, and explicit confirm. For shortcuts, require focus inside the QC workspace and show a review step for anything except single-line accept.
- Effort (S/M/L): M.
- Verification method: Playwright/RTL tests for bulk hold/reject modal content, required reason, and shortcut scope; keyboard tests ensuring no mutation occurs outside the focused QC workspace.

## Finding 3: Putaway posting is direct from button and Ctrl+P without an inventory-impact confirmation

- Finding: Draft putaway creation has validation warnings, but posting an existing putaway directly calls `postPutawayMutation.mutate(ctx.putawayId)` from the button and `Ctrl+P` shortcut. The confirmation state shown after completion cannot prevent the post.
- Evidence (file path, component, function): `ui/src/features/receiving/pages/PutawayPlanningPage.tsx`, keyboard shortcut lines 88-95; post button lines 437-446; completion copy lines 137-140.
- Operational impact: Posting putaway moves accepted stock into storage and makes it available. A wrong destination or quantity becomes operational truth before the operator reviews a final source/destination movement summary.
- Workflow affected: Putaway, inventory visibility.
- Severity (Critical / High / Medium / Low): Critical.
- Recommendation: Add a post confirmation modal showing every line, from location, to location, quantity, UOM, blocked/hold status, and resulting availability. Disable Ctrl+P until the same review state is open.
- Effort (S/M/L): M.
- Verification method: UI test that "Post putaway" opens preview first; test direct shortcut cannot post without preview; mutation mock verifies confirmed payload only.

## Finding 4: Transfer posting lacks source availability context before mutation

- Finding: The transfer screen validates required fields, positive quantity, UOM, and source/destination difference, but it does not display on-hand, available, allocated/on-hold/in-transit, or source shortages for the selected item/location before "Post transfer".
- Evidence (file path, component, function): `ui/src/features/inventory/pages/InventoryTransferCreatePage.tsx`, `validateTransferForm` lines 97-115 and mutation lines 67-78; `ui/src/features/inventory/components/InventoryTransferForm.tsx`, fields and submit button lines 45-130.
- Operational impact: Operators must guess whether the source can support the move and learn from backend failure. In a warehouse, this increases trial-and-error and can cause wrong source selection under time pressure.
- Workflow affected: Transfers, inventory visibility.
- Severity (Critical / High / Medium / Low): High.
- Recommendation: After item/source selection, show a source stock panel with on-hand, available, allocated, on-hold/quarantined, in-transit, and projected remaining after transfer. Keep backend rejection, but make the UI prevent obvious unavailable transfers.
- Effort (S/M/L): M.
- Verification method: Mock inventory summary/ATP query in UI test; assert warning/disabled submit when requested quantity exceeds available; assert location-specific quantities are displayed.

## Finding 5: Shipment creation allows free-text ship-from and unbounded ship quantities

- Finding: Sales order detail uses a free-text `shipFromLocationId` input and enables shipment creation when any line quantity is greater than zero. The UI does not bound ship quantity by order quantity, backorder, reservation state, or available stock before creating the shipment document.
- Evidence (file path, component, function): `ui/src/features/orderToCash/pages/SalesOrderDetailPage.tsx`, `canCreateShipment` lines 196-201; ship-from input lines 327-334; line quantity input lines 424-438; create mutation payload lines 113-135.
- Operational impact: Operators can create shipment documents with mistyped source IDs or quantities that exceed demand/reservation readiness, pushing errors downstream to posting or creating misleading draft shipments.
- Workflow affected: Pick / pack / ship, allocation.
- Severity (Critical / High / Medium / Low): Critical.
- Recommendation: Replace free-text ship-from with location search/select, display line-level ordered/backorder/reserved/allocated/available quantities, and cap or warn on ship quantities above open demand or available allocated stock.
- Effort (S/M/L): M.
- Verification method: UI test for location selector; line quantity tests for over-order and over-available states; mutation test that invalid quantities do not call `createShipment`.

## Finding 6: ATP screen copy simplifies available-to-promise as on-hand minus reservations

- Finding: The ATP page description says "on-hand minus reservations"; it does not mention holds/quarantine, blocked locations, in-transit, or other unavailable states.
- Evidence (file path, component, function): `ui/src/features/inventory/pages/AtpQueryPage.tsx`, page description lines 45-49; ATP columns lines 140-150 and results lines 172-180.
- Operational impact: Users may equate ATP with a simple arithmetic shortcut and make allocation decisions that ignore hold/quarantine or location constraints, especially when viewing all locations.
- Workflow affected: Inventory visibility, allocation, pick / pack / ship.
- Severity (Critical / High / Medium / Low): High.
- Recommendation: Change explanatory copy to "ledger-backed availability after reservations and blocking states"; show blocked/hold/in-transit columns or an explicit "excluded from ATP" note when available.
- Effort (S/M/L): S.
- Verification method: Copy assertion in UI test; fixture showing held/in-transit stock with ATP lower than on-hand and visible explanation.

## Finding 7: Cycle count posting does not expose line-level variance reasoning before adjustment

- Finding: Count lines accept optional reason codes and notes, while the post confirmation shows only aggregate variance count and total absolute variance. The UI does not require reasons for variance lines or show per-line book-vs-count adjustment consequences before posting.
- Evidence (file path, component, function): `ui/src/features/inventory/components/InventoryCountForm.tsx`, reason code field lines 200-206; `ui/src/features/inventory/pages/InventoryCountDetailPage.tsx`, save payload maps empty reason to undefined lines 126-137; post modal aggregate-only copy lines 347-368.
- Operational impact: Physical/recorded divergence can be converted into an authoritative adjustment without enough operator investigation context, making later reconciliation harder.
- Workflow affected: Cycle counting / reconciliation, inventory visibility.
- Severity (Critical / High / Medium / Low): Critical.
- Recommendation: Show a variance review table before post with item, location, UOM, book quantity, counted quantity, delta, adjustment direction, unit cost requirement, and required reason for every variance line.
- Effort (S/M/L): M.
- Verification method: UI test that post confirm lists variance lines and disables confirm until each variance has a reason; API payload test for reason propagation.

## Finding 8: On-hand import can be applied without lot/serial support or final review

- Finding: The admin import supports `on_hand` snapshots with required `sku`, `locationCode`, `uom`, and `quantity`, explicitly says lots/serials are not supported, and applies valid imports directly from the validation results card.
- Evidence (file path, component, function): `ui/src/features/admin/pages/ImportDataPage.tsx`, import field definition lines 31-34; support warning lines 208-214; validate/apply actions lines 343-349; `onApply` lines 132-153.
- Operational impact: Bulk stock onboarding or correction can create stock records that omit lot/serial traceability for tracked items, and a single click after validation can commit many rows without a final stock-impact summary.
- Workflow affected: Admin/config, inventory visibility, traceability, cycle counting/reconciliation.
- Severity (Critical / High / Medium / Low): Critical.
- Recommendation: Block on-hand import for lot/serial tracked items until lot/serial columns are supported, or route those rows to an exception queue. Add an apply confirmation summarizing rows, locations, net quantity impact, tracked-item exclusions, and movement/adjustment consequences.
- Effort (S/M/L): L.
- Verification method: Import validation tests with lot/serial tracked item fixtures; UI test requiring final apply confirmation; audit log/movement link assertion after apply.

## Finding 9: No dedicated traceability route is exposed for lot, serial, recall, or forward/backward trace

- Finding: The UI route registry includes movements and QC events but no route for lots, recalls, or trace runs. Backend traceability/compliance services exist.
- Evidence (file path, component, function): `ui/src/app/routeData.tsx`, `appShellRoutes` imports and route list lines 1-56; `ui/src/features/receiving/routes.tsx`, QC event detail route lines 120-132; backend services `src/services/compliance.service.ts` and `src/services/lotTraceabilityEngine.ts`.
- Operational impact: During recall, supplier defect investigation, or lot genealogy review, users must infer traceability through receipt, movement, and QC screens instead of executing a direct trace workflow.
- Workflow affected: Traceability, receiving, production reporting/backflush, shipping.
- Severity (Critical / High / Medium / Low): High.
- Recommendation: Add a traceability workspace with lot/serial search, forward/backward trace, movement links, receipt/QC/production/shipment context, and exportable recall evidence.
- Effort (S/M/L): L.
- Verification method: Route inventory test; fixture-driven trace UI test from received lot to production output and shipment; accessibility test for trace tables.

## Finding 10: Disabled action explanations are often stored only in `title`

- Finding: Reservation list/detail buttons pass guard messages through the HTML `title` attribute, which is not reliable for keyboard or touch users and is easy to miss during scanning.
- Evidence (file path, component, function): `ui/src/features/orderToCash/pages/ReservationsListPage.tsx`, disabled allocate/cancel buttons with `title` lines 228-244; `ui/src/features/orderToCash/pages/ReservationDetailPage.tsx`, action buttons with `title` lines 286-320.
- Operational impact: Operators can see unavailable actions but may not understand the required next step, increasing dead-end behavior and support escalation.
- Workflow affected: Allocation, pick / pack / ship.
- Severity (Critical / High / Medium / Low): Medium.
- Recommendation: Use visible `ActionGuardMessage` or inline blocked-state text per row/action; keep `title` only as a supplement.
- Effort (S/M/L): S.
- Verification method: UI test that blocked action reason text is present in the DOM and associated with disabled controls.

## Finding 11: Shared table primitives do not provide sorting, filtering, or column-level affordances by default

- Finding: `DataTable` supports rows, columns, keyboard navigation, row actions, and row state, but no sortable headers or built-in filter affordances. Several operational screens use plain tables or `DataTable` for long lists.
- Evidence (file path, component, function): `ui/src/shared/ui/DataTable.tsx`, props lines 23-45 and table header rendering lines 185-207; `ui/src/components/Table.tsx`, simple table props lines 4-21; examples include `ReceiptLinesTable`, `ReservationsListPage`, and `ShipmentDetailPage`.
- Operational impact: Operators working under time pressure must scan sequentially to find exceptions unless each page hand-builds filters. This increases missed discrepancies, wrong-line selection, and slow exception handling.
- Workflow affected: Receiving, QC, inventory visibility, allocation, pick / pack / ship, traceability.
- Severity (Critical / High / Medium / Low): Medium.
- Recommendation: Add reusable sortable headers, optional column filters, density controls for operational tables, and anomaly-first default sorting where rows have warnings/dangers.
- Effort (S/M/L): M.
- Verification method: Component tests for sorting/filtering; page tests that discrepancy/hold/negative rows sort to the top.

## Finding 12: Purchase order creation can submit for approval without a confirmation step

- Finding: PO detail uses a submit confirmation alert, but PO creation directly calls `submitPo('submitted')` from the create screen button once client readiness is satisfied.
- Evidence (file path, component, function): `ui/src/features/purchaseOrders/pages/PurchaseOrderCreatePage.tsx`, create submit button lines 337-343; `PurchaseOrderDetailPage` confirmation alert lines 486-507.
- Operational impact: A user creating a PO can take the faster visible path and commit a buying/receiving workflow without reviewing the lock/approval consequence in the same way as detail-page submission.
- Workflow affected: Purchasing / PO creation, receiving.
- Severity (Critical / High / Medium / Low): Medium.
- Recommendation: Reuse the detail-page confirmation pattern for create-page submit, including vendor, ship-to, receiving location, expected date, line count, subtotal, and lock consequence.
- Effort (S/M/L): S.
- Verification method: UI test that create-page submit opens confirmation before mutation and that save draft still posts immediately as draft.

## Finding 13: Admin location parent selection uses raw ID input

- Finding: Location form asks for "Parent Location ID" as free text rather than a constrained location selector.
- Evidence (file path, component, function): `ui/src/features/locations/components/LocationForm.tsx`, `parentLocationId` state lines 24-31 and parent input lines 116-124.
- Operational impact: A mistyped parent ID can create invalid or confusing warehouse hierarchy, making putaway, transfer filtering, and location-scoped inventory review harder for operators.
- Workflow affected: Admin/config, putaway, transfers, inventory visibility.
- Severity (Critical / High / Medium / Low): Medium.
- Recommendation: Use a searchable location selector constrained to valid parent candidates and show resulting path/depth before saving.
- Effort (S/M/L): S.
- Verification method: UI test for parent selector options, invalid parent prevention, and path preview after selection.

## Workflow Coverage Self-Check

- Purchasing / PO creation: Findings 12 and route inventory.
- Receiving: Findings 1, 2, 3 and route inventory.
- QC accept / reject / hold: Findings 1 and 2.
- Putaway: Finding 3.
- Inventory visibility: Findings 4, 6, 9, 11.
- Transfers: Finding 4.
- Allocation: Findings 5, 6, 10.
- Pick / pack / ship: Findings 5 and 10.
- Production reporting / backflush: Finding 9 and route inventory; `WorkOrderExecutionWorkspace` includes readiness, preview, and explicit confirmation, so no unsupported high-risk UI finding was added for its primary execution path.
- Cycle counting / reconciliation: Finding 7.
- Traceability: Findings 8 and 9.
- Admin/config: Findings 8 and 13.

## Accessibility Notes

- Positive evidence: shared `Modal` traps focus and restores focus (`ui/src/components/Modal.tsx`); `DataTable` can expose keyboard navigation when enabled (`ui/src/shared/ui/DataTable.tsx`).
- Risks included above: title-only guard messaging, glyph-heavy QC status snippets, native prompts for bulk QC, and missing structured table affordances.
