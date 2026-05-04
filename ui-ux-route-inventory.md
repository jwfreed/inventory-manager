# UI/UX Route Inventory

Audit date: 2026-05-04

## System Mapping

- Framework: React 19 + Vite, routed with `createBrowserRouter` in `ui/src/app/routes.tsx`.
- Route composition: feature route arrays are collected in `ui/src/app/routeData.tsx`; permission guards are applied by `applyPermissionGuard()` in `ui/src/app/routes.tsx`.
- State/data layer: React Query (`@tanstack/react-query`) is used for server state and mutations. Local form state is generally `useState`.
- Navigation shell: `ui/src/app/layout/AppShell.tsx` with section navigation from `ui/src/app/layout/SectionNav.tsx`.
- Shared UI: `ui/src/shared/ui/*` plus legacy `ui/src/components/*`. Key primitives include `DataTable`, `Panel`, `PageHeader`, `Alert`, `Modal`, `Button`, `Combobox`, and `SearchableSelect`.
- Domain source of truth: `docs/inventory/domain-invariants.md` defines distinct quantity states, explicit workflow transitions, audit reasons, and UI correctness boundaries.

## Domain Model Observed

- Inbound: purchase orders, receipts, QC events, hold dispositions, putaways.
- Inventory: ATP, inventory movements, transfers, counts, license plates, operations/activity boards.
- Outbound: sales orders, reservations, shipments, returns.
- Production: work orders, readiness, reservations, execution, disassembly, issue/receipt movements, scrap.
- Admin/config: items, locations, imports, inventory health, replenishment policies, routings/work centers.
- Traceability support exists in backend services (`src/services/compliance.service.ts`, `src/services/lotTraceabilityEngine.ts`, `src/services/inventoryReplayEngine.ts`) but no app-shell UI route exposes lot/recall trace workflows.

## Route And Screen Inventory

| Route | User role / permission | Workflow | Primary task | Key components/files | Risk |
|---|---|---|---|---|---|
| `/purchase-orders` | `purchasing:read` | Purchasing / PO creation | Search and manage POs | `ui/src/features/purchaseOrders/routes.tsx`, `PurchaseOrdersListPage`, `PurchaseOrdersGroupTable` | Medium |
| `/purchase-orders/new` | `purchasing:write` | Purchasing / PO creation | Create draft or submitted PO | `PurchaseOrderCreatePage`, `PurchaseOrderVendorSection`, `PurchaseOrderLinesSection`, `PurchaseOrderLogisticsSection`, `PurchaseOrderReadinessPanel` | High |
| `/purchase-orders/:id` | `purchasing:read`; write/approve/void actions by permission | Purchasing / PO lifecycle | Edit draft, submit, approve, cancel, close header/line | `PurchaseOrderDetailPage`, `PurchaseOrderActionBar`, `PurchaseOrderCloseModal`, `PurchaseOrderLinesTable`, `AuditTrailTable` | High |
| `/receiving` | `purchasing:read` | Receiving / QC overview | View receiving workbench | `ReceivingPage`, `ReceivingLayout`, `RecentReceiptsTable`, workflow widgets | High |
| `/receiving/receipt` | `purchasing:write` | Receiving | Select PO, capture quantities, discrepancies, lots/serials, post receipt | `ReceiptCapturePage`, `ReceiptLinesTable`, `ReceiptSummaryPanel`, `ReceivingContext` | Critical |
| `/receipts` | `purchasing:read` | Receiving visibility | Review posted receipts and QC status | `ReceiptsIndexPage`, `ReceiptDocument` | Medium |
| `/receipts/:receiptId` | `purchasing:read` | Receiving / QC / Putaway | Read receipt and navigate to QC or putaway | `ReceiptDetailPage`, `ReceiptDocument` | High |
| `/qc/receipts` | `inventory:qc:write` | QC | Queue receipts needing QC | `QcReceiptsQueuePage`, `QcBatchQueue`, `SearchFiltersBar` | High |
| `/qc/receipts/:receiptId` | `inventory:qc:write` | QC | Accept, hold, reject, resolve held quantity | `QcClassificationPage`, `QcDetailPanel`, `BulkOperationsBar`, `ReceivingContext` | Critical |
| `/receiving/qc` | `inventory:qc:write` | QC | Legacy/query-param QC path | `QcClassificationPage` | Critical |
| `/qc-events/:qcEventId` | `inventory:qc:write` | Traceability / QC | Inspect a QC event | `QcEventDetailPage` | Medium |
| `/receiving/putaway` | `inventory:putaway:write` | Putaway | Create and post putaway for accepted stock | `PutawayPlanningPage`, `DraggablePutawayLinesEditor`, `PutawaySummaryTable`, `ReceivingContext` | Critical |
| `/atp` | `inventory:read` | Inventory visibility / allocation support | Query available-to-promise | `AtpQueryPage`, `AtpResultsTable` | High |
| `/lpns` | `inventory:read` | Inventory visibility / trace support | View license plates | `LicensePlatesPage` | Medium |
| `/inventory-transfers/new` | `inventory:transfers:write` | Transfers | Post direct location-to-location transfer | `InventoryTransferCreatePage`, `InventoryTransferForm`, `TransferOperationPanel` | Critical |
| `/inventory/operations` | `inventory:read` | Inventory visibility | Review latest operational activity | `InventoryOperationsDashboardPage` | Medium |
| `/inventory/activity` | `inventory:read` | Inventory visibility | Warehouse activity board | `WarehouseActivityBoardPage` | Medium |
| `/inventory-counts` | `inventory:read` | Cycle counting / reconciliation | List counts | `InventoryCountsListPage`, `InventoryCountsTable` | High |
| `/inventory-counts/new` | `inventory:counts:write` | Cycle counting / reconciliation | Create draft count | `InventoryCountCreatePage`, `InventoryCountForm` | High |
| `/inventory-counts/:id` | `inventory:read`; edit by `inventory:counts:write` | Cycle counting / reconciliation | Save draft and post adjustment | `InventoryCountDetailPage`, `InventoryCountForm` | Critical |
| `/movements` | `inventory:read` | Traceability / inventory visibility | Search movement ledger | `MovementsListPage`, `MovementFilters`, `MovementsTable` | High |
| `/movements/:movementId` | `inventory:read` | Traceability | Inspect movement, lines, source link, override metadata | `MovementDetailPage`, `MovementLinesTable`, `useMovementDetailViewModel` | High |
| `/items` | `masterdata:read` | Inventory visibility / admin config | Item list, filtering, item creation entry | `ItemsListPage`, `ItemForm` | High |
| `/items/:id` | `masterdata:read` | Inventory visibility / trace support / admin config | Item inventory, lifecycle, BOM/routing/config | `ItemDetailPage`, `ItemInventorySection`, `InventoryLifecycle`, `ItemForm` | High |
| `/locations` | `masterdata:read` | Inventory visibility / admin config | Location list and templates | `LocationsListPage`, `LocationForm` | High |
| `/locations/:id` | `masterdata:read` | Inventory visibility / admin config | Location metadata and scoped inventory | `LocationDetailPage`, `LocationForm` | High |
| `/reservations` | `outbound:read` | Allocation | Allocate or cancel reservations | `ReservationsListPage`, `reservationActionPolicy` | Critical |
| `/reservations/:id` | `outbound:read` | Allocation | Allocate, cancel, fulfill reservation | `ReservationDetailPage`, `reservationActionPolicy` | Critical |
| `/sales-orders` | `outbound:read` | Allocation / pick-pack-ship entry | Manage sales orders | `SalesOrdersListPage` | High |
| `/sales-orders/new` | `outbound:write` | Allocation / demand creation | Create sales order | `SalesOrderCreatePage` | High |
| `/sales-orders/:id` | `outbound:read` | Pick / pack / ship | Create shipment document from order lines | `SalesOrderDetailPage` | Critical |
| `/shipments` | `outbound:read` | Pick / pack / ship | View shipments | `ShipmentsListPage` | High |
| `/shipments/:id` | `outbound:read`; post by `outbound:post` | Pick / pack / ship | Post shipment movement | `ShipmentDetailPage` | Critical |
| `/work-orders` | `production:read` | Production reporting / backflush | Manage work orders | `WorkOrdersListPage`, `WorkOrdersTable` | High |
| `/work-orders/new` | `production:write` | Production reporting / backflush | Create work order | `WorkOrderCreatePage`, `WorkOrderHeaderSection`, `WorkOrderBomSection` | High |
| `/work-orders/:id` | `production:read`; mutations by `production:write` | Production reporting / backflush | Ready/cancel/close/execute production or disassembly | `WorkOrderDetailPage`, `WorkOrderExecutionWorkspace`, `WorkOrderLifecycleActions` | Critical |
| `/production-overview` | `production:read` | Production reporting visibility | Production analytics | `ProductionOverviewPage` | Medium |
| `/admin/inventory-health` | `admin:health` | Admin/config / reconciliation | Review health gates and run cost projection | `InventoryHealthPage` | High |
| `/admin/imports` | `admin:imports` | Admin/config | CSV import for items, locations, on-hand snapshot | `ImportDataPage` | Critical |

## Coverage Check

- Purchasing / PO creation: covered.
- Receiving: covered.
- QC accept / reject / hold: covered.
- Putaway: covered.
- Inventory visibility: covered.
- Transfers: covered.
- Allocation: covered.
- Pick / pack / ship: covered.
- Production reporting / backflush: covered.
- Cycle counting / reconciliation: covered.
- Traceability: covered; dedicated lot/recall UI route not found.
- Admin/config: covered.
