# Phase 0 Repo Map (Remediation)

## API routes
- `src/server.ts`
- `src/routes/purchaseOrders.routes.ts`
- `src/routes/receipts.routes.ts`
- `src/routes/qc.routes.ts`
- `src/routes/putaways.routes.ts`
- `src/routes/ledger.routes.ts`
- `src/routes/inventorySummary.routes.ts`
- `src/routes/inventorySnapshot.routes.ts`
- `src/routes/adjustments.routes.ts`
- `src/routes/auth.routes.ts`

## Services
- `src/services/purchaseOrders.service.ts`
- `src/services/receipts.service.ts`
- `src/services/qc.service.ts`
- `src/services/putaways.service.ts`
- `src/services/ledger.service.ts`
- `src/services/inbound/receivingAggregations.ts`
- `src/services/inventorySummary.service.ts`
- `src/services/inventorySnapshot.service.ts`
- `src/services/adjustments.service.ts`

## Schemas + validators
- `src/schemas/purchaseOrders.schema.ts`
- `src/schemas/receipts.schema.ts`
- `src/schemas/qc.schema.ts`
- `src/schemas/putaways.schema.ts`
- `src/schemas/ledger.schema.ts`

## Migrations
- `src/migrations/1765760463000_phase0_feature1_create_inventory_movements.ts`
- `src/migrations/1765760464000_phase0_feature1_create_inventory_movement_lines.ts`
- `src/migrations/1765760522000_phase0_feature2_create_audit_log.ts`
- `src/migrations/1765764062000_phase1_feature1_create_purchase_orders.ts`
- `src/migrations/1765764121000_phase1_feature2_create_purchase_order_receipts.ts`
- `src/migrations/1765764122000_phase1_feature2_create_purchase_order_receipt_lines.ts`
- `src/migrations/1765764123000_phase1_feature2_create_qc_events.ts`
- `src/migrations/1765764181000_phase1_feature3_create_putaways.ts`
- `src/migrations/1765764182000_phase1_feature3_create_putaway_lines.ts`

## UI pages
- `ui/src/features/purchaseOrders/pages/PurchaseOrderDetailPage.tsx`
- `ui/src/features/purchaseOrders/pages/PurchaseOrdersListPage.tsx`
- `ui/src/features/receiving/pages/ReceivingPage.tsx`
- `ui/src/features/receiving/components/QcDetailPanel.tsx`
- `ui/src/features/items/pages/ItemDetailPage.tsx`
- `ui/src/features/ledger/pages/MovementsListPage.tsx`
- `ui/src/features/ledger/pages/MovementDetailPage.tsx`

## Audit + events
- `src/lib/events.ts`
- `src/migrations/1765760522000_phase0_feature2_create_audit_log.ts`
