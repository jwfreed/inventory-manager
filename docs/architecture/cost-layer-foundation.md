# Cost Layer Foundation

## Overview

The inventory cost layer system provides accurate FIFO (First-In-First-Out) cost tracking for inventory items. Instead of relying solely on a simple moving average or standard cost, the system tracks individual "layers" of inventory, each with its own unit cost based on when it was received.

## Key Benefits

1. **Accurate COGS**: Calculate true Cost of Goods Sold by tracking which specific receipts were consumed
2. **FIFO Costing**: Automatically consume from oldest layers first for proper inventory valuation
3. **Audit Trail**: Complete history of which layers were consumed for each transaction
4. **Financial Accuracy**: Meet accounting standards for inventory valuation and COGS recognition
5. **Cost Traceability**: Trace costs from receipt through production to final sale

## Database Schema

### inventory_cost_layers

Tracks individual cost layers for inventory at each location:

- **id**: Unique identifier
- **tenant_id**: Multi-tenant isolation
- **item_id**: The item being tracked
- **location_id**: Where the inventory is located
- **uom**: Unit of measure
- **layer_date**: When this layer was created (for FIFO ordering)
- **layer_sequence**: Sequence number for layers created on same date
- **original_quantity**: Initial quantity when layer was created
- **remaining_quantity**: How much is left in this layer (decreases as consumed)
- **unit_cost**: Cost per unit for this layer
- **extended_cost**: Total value (remaining_quantity × unit_cost)
- **source_type**: Origin of the layer (`receipt`, `production`, `adjustment`, `opening_balance`, `transfer_in`)
- **source_document_id**: Reference to source document
- **movement_id**: Link to inventory movement that created this layer
- **lot_id**: Optional lot tracking
- **notes**: Additional context

### cost_layer_consumptions

Tracks how cost layers are consumed over time:

- **id**: Unique identifier
- **tenant_id**: Multi-tenant isolation
- **cost_layer_id**: Which layer was consumed from
- **consumed_quantity**: Amount consumed from this layer
- **unit_cost**: Cost per unit at time of consumption (from layer)
- **extended_cost**: Total cost (consumed_quantity × unit_cost)
- **consumption_type**: Type of consumption (`issue`, `production_input`, `sale`, `adjustment`, `scrap`, `transfer_out`)
- **consumption_document_id**: Reference to consuming document
- **movement_id**: Link to inventory movement that consumed from this layer
- **consumed_at**: When the consumption occurred
- **notes**: Additional context

## Core Service Functions

### costLayers.service.ts

#### createCostLayer()

Creates a new cost layer from a receipt, production completion, or adjustment:

```typescript
const layer = await createCostLayer({
  tenant_id: 'tenant-123',
  item_id: 'item-456',
  location_id: 'warehouse-A',
  uom: 'EA',
  quantity: 100,
  unit_cost: 25.50,
  source_type: 'receipt',
  source_document_id: 'receipt-line-789',
  movement_id: 'movement-101',
  notes: 'Received from PO-1234'
});
```

#### consumeCostLayers()

Consumes from cost layers in FIFO order (oldest first):

```typescript
const result = await consumeCostLayers({
  tenant_id: 'tenant-123',
  item_id: 'item-456',
  location_id: 'warehouse-A',
  quantity: 75,
  consumption_type: 'production_input',
  consumption_document_id: 'work-order-555',
  movement_id: 'movement-102'
});

console.log(`Total COGS: $${result.total_cost}`);
console.log(`Weighted Avg Cost: $${result.weighted_average_cost}`);
console.log(`Consumed from ${result.consumptions.length} layers`);
```

#### getCurrentWeightedAverageCost()

Gets the current weighted average cost across all available layers:

```typescript
const costInfo = await getCurrentWeightedAverageCost(
  'tenant-123',
  'item-456',
  'warehouse-A'
);

if (costInfo) {
  console.log(`Available: ${costInfo.total_quantity} units`);
  console.log(`Total Value: $${costInfo.total_value}`);
  console.log(`Avg Cost: $${costInfo.average_cost}`);
}
```

#### getCOGSForPeriod()

Calculates COGS for a time period:

```typescript
const cogs = await getCOGSForPeriod(
  'tenant-123',
  new Date('2024-01-01'),
  new Date('2024-01-31'),
  'item-456', // optional: specific item
  'warehouse-A' // optional: specific location
);

cogs.forEach(item => {
  console.log(`Item ${item.item_id}: COGS = $${item.total_cogs}`);
});
```

#### getCostLayerDetails()

Gets detailed layer information for an item:

```typescript
const layers = await getCostLayerDetails(
  'tenant-123',
  'item-456',
  'warehouse-A'
);

layers.forEach(layer => {
  console.log(`Layer from ${layer.layer_date}`);
  console.log(`  Original: ${layer.original_quantity} @ $${layer.unit_cost}`);
  console.log(`  Remaining: ${layer.remaining_quantity}`);
  console.log(`  Consumed: ${layer.consumed_quantity} in ${layer.consumption_count} transactions`);
});
```

## Integration Points

### Receipt Processing

When creating a purchase order receipt with unit costs:

```typescript
// In receipts.service.ts, after creating receipt line
await processReceiptIntoCostLayers({
  tenant_id,
  item_id: poLine.item_id,
  location_id: receipt.receivedToLocationId,
  uom: line.uom,
  quantity: line.quantityReceived,
  unit_cost: unitCost,
  source_type: 'receipt',
  source_document_id: receiptLineId,
  movement_id: movementId,
  received_at: new Date(receipt.receivedAt)
});
```

### Work Order Completion

When posting production output:

```typescript
// In workOrderExecution.service.ts, when posting completion
const layer = await createCostLayer({
  tenant_id,
  item_id: outputItem.id,
  location_id: completionLocation,
  uom: outputItem.base_uom,
  quantity: quantityProduced,
  unit_cost: calculatedProductionCost, // From BOM costs + labor + overhead
  source_type: 'production',
  source_document_id: workOrderId,
  movement_id: completionMovementId
});
```

### Material Issue

When issuing materials for production:

```typescript
// In workOrderExecution.service.ts, when issuing materials
const costResult = await consumeCostLayers({
  tenant_id,
  item_id: componentItem.id,
  location_id: issueFromLocation,
  quantity: quantityIssued,
  consumption_type: 'production_input',
  consumption_document_id: workOrderId,
  movement_id: issueMovementId
});

// Use costResult.total_cost for COGS tracking
// Use costResult.weighted_average_cost for unit cost on movement line
```

### Inventory Adjustments

When posting inventory adjustments (increases):

```typescript
// For positive adjustments (add inventory)
await createCostLayer({
  tenant_id,
  item_id: adjustmentLine.itemId,
  location_id: adjustmentLine.locationId,
  uom: adjustmentLine.uom,
  quantity: Math.abs(adjustmentLine.quantityDelta),
  unit_cost: adjustmentLine.unitCost || itemStandardCost,
  source_type: 'adjustment',
  source_document_id: adjustmentLineId,
  movement_id: adjustmentMovementId
});

// For negative adjustments (remove inventory)
await consumeCostLayers({
  tenant_id,
  item_id: adjustmentLine.itemId,
  location_id: adjustmentLine.locationId,
  quantity: Math.abs(adjustmentLine.quantityDelta),
  consumption_type: 'adjustment',
  consumption_document_id: adjustmentLineId,
  movement_id: adjustmentMovementId
});
```

### Sales/Shipments

When shipping orders:

```typescript
// When picking/shipping inventory
const costResult = await consumeCostLayers({
  tenant_id,
  item_id: shipmentLine.itemId,
  location_id: pickLocation,
  quantity: quantityShipped,
  consumption_type: 'sale',
  consumption_document_id: shipmentLineId,
  movement_id: shipmentMovementId
});

// Record COGS for financial reporting
await recordCOGS(costResult.total_cost, shipmentLine);
```

## API Endpoints

### GET /api/cost-layers/item/:itemId

Get all cost layers for an item (optionally filtered by location)

**Query Parameters:**
- `locationId` (optional): Filter by location

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "layer-123",
      "item_id": "item-456",
      "location_id": "warehouse-A",
      "layer_date": "2024-01-15T10:00:00Z",
      "original_quantity": 100,
      "remaining_quantity": 45,
      "unit_cost": 25.50,
      "extended_cost": 1147.50,
      "source_type": "receipt",
      "consumed_quantity": 55,
      "consumption_count": 3
    }
  ]
}
```

### GET /api/cost-layers/available

Get available cost layers for an item/location in FIFO order

**Query Parameters:**
- `itemId` (required)
- `locationId` (required)
- `lotId` (optional): Filter by lot

### GET /api/cost-layers/average-cost

Get current weighted average cost

**Query Parameters:**
- `itemId` (required)
- `locationId` (required)

**Response:**
```json
{
  "success": true,
  "data": {
    "average_cost": 24.75,
    "total_quantity": 150,
    "total_value": 3712.50
  }
}
```

### GET /api/cost-layers/cogs

Get COGS for a time period

**Query Parameters:**
- `startDate` (required): ISO date
- `endDate` (required): ISO date
- `itemId` (optional)
- `locationId` (optional)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "item_id": "item-456",
      "location_id": "warehouse-A",
      "total_quantity_consumed": 250,
      "total_cogs": 6187.50,
      "average_cost": 24.75
    }
  ]
}
```

### POST /api/cost-layers

Create a new cost layer

**Request Body:**
```json
{
  "item_id": "item-456",
  "location_id": "warehouse-A",
  "uom": "EA",
  "quantity": 100,
  "unit_cost": 25.50,
  "source_type": "receipt",
  "source_document_id": "receipt-line-789",
  "movement_id": "movement-101"
}
```

### POST /api/cost-layers/consume

Consume from cost layers (FIFO)

**Request Body:**
```json
{
  "item_id": "item-456",
  "location_id": "warehouse-A",
  "quantity": 75,
  "consumption_type": "production_input",
  "consumption_document_id": "work-order-555",
  "movement_id": "movement-102"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "total_cost": 1912.50,
    "weighted_average_cost": 25.50,
    "consumptions": [
      {
        "layer_id": "layer-123",
        "quantity": 50,
        "unit_cost": 25.50,
        "extended_cost": 1275.00
      },
      {
        "layer_id": "layer-124",
        "quantity": 25,
        "unit_cost": 25.50,
        "extended_cost": 637.50
      }
    ]
  }
}
```

### GET /api/cost-layers/:layerId/consumptions

Get consumption history for a specific cost layer

### DELETE /api/cost-layers/:layerId

Delete a cost layer (only if not consumed - for error correction)

## Migration Strategy

### Phase 1: Parallel Tracking (Current)

- Existing moving average cost system continues to work
- Cost layers are created for all new receipts/productions
- Both systems run in parallel
- Reports can optionally use cost layer data

### Phase 2: Initialize Historical Layers

Run a one-time script to create opening balance layers for existing inventory:

```typescript
// scripts/initialize-cost-layers.ts
import { query } from '../src/db';
import { initializeCostLayersFromSnapshot } from '../src/services/costLayersIntegration.service';

// Get current inventory snapshot
const snapshot = await query(`
  SELECT item_id, location_id, SUM(quantity_on_hand) as qty, AVG(average_cost) as cost
  FROM items
  WHERE quantity_on_hand > 0
  GROUP BY item_id, location_id
`);

for (const row of snapshot.rows) {
  await initializeCostLayersFromSnapshot(
    tenant_id,
    row.item_id,
    row.location_id,
    Number(row.qty),
    Number(row.cost)
  );
}
```

### Phase 3: Switch Reports to Cost Layers

Update reports to use cost layer data:
- Inventory valuation → sum of extended_cost from active layers
- COGS reports → sum from cost_layer_consumptions table
- Cost variance → compare standard_cost to layer-based average

### Phase 4: Deprecate Moving Average (Future)

Once cost layers are stable and trusted:
- Keep average_cost column for caching/performance
- But make it read-only, calculated from cost layers
- Eventually can remove manual updates to average_cost

## Best Practices

1. **Always create layers for receipts**: Any time inventory is added (receipts, production, adjustments), create a cost layer
2. **Always consume for issues**: Any time inventory is removed (issues, sales, consumption), consume from layers
3. **Use accurate costs**: For receipts, use actual unit cost from PO/invoice, not standard cost
4. **Handle zero-cost carefully**: For free samples or donations, use zero cost but still create layers
5. **Lot tracking**: If items are lot-tracked, always specify lot_id to maintain proper FIFO within lots
6. **Transaction integrity**: Use database transactions when creating/consuming layers with inventory movements
7. **Error handling**: If cost layer consumption fails due to insufficient quantity, the entire transaction should roll back

## Reporting Examples

### Inventory Valuation by Cost Layer

```sql
SELECT 
  i.sku,
  i.name,
  l.code as location,
  SUM(cl.remaining_quantity) as qty_on_hand,
  SUM(cl.extended_cost) as total_value,
  SUM(cl.extended_cost) / NULLIF(SUM(cl.remaining_quantity), 0) as weighted_avg_cost
FROM inventory_cost_layers cl
JOIN items i ON cl.item_id = i.id
JOIN locations l ON cl.location_id = l.id
WHERE cl.tenant_id = $1 
  AND cl.remaining_quantity > 0
GROUP BY i.sku, i.name, l.code
ORDER BY total_value DESC;
```

### COGS by Month

```sql
SELECT 
  DATE_TRUNC('month', clc.consumed_at) as month,
  i.sku,
  i.name,
  SUM(clc.consumed_quantity) as qty_consumed,
  SUM(clc.extended_cost) as cogs
FROM cost_layer_consumptions clc
JOIN inventory_cost_layers cl ON clc.cost_layer_id = cl.id
JOIN items i ON cl.item_id = i.id
WHERE clc.tenant_id = $1
  AND clc.consumption_type = 'sale'
  AND clc.consumed_at >= $2
  AND clc.consumed_at < $3
GROUP BY DATE_TRUNC('month', clc.consumed_at), i.sku, i.name
ORDER BY month DESC, cogs DESC;
```

### Cost Layer Age Analysis

```sql
SELECT 
  i.sku,
  i.name,
  l.code as location,
  cl.layer_date,
  AGE(NOW(), cl.layer_date) as age,
  cl.remaining_quantity,
  cl.extended_cost
FROM inventory_cost_layers cl
JOIN items i ON cl.item_id = i.id
JOIN locations l ON cl.location_id = l.id
WHERE cl.tenant_id = $1 
  AND cl.remaining_quantity > 0
ORDER BY cl.layer_date ASC
LIMIT 100;
```

## Troubleshooting

### Insufficient Quantity Error

If you get "Insufficient quantity in cost layers" when trying to consume:

1. Check if cost layers exist for the item/location
2. Verify available quantity matches physical inventory
3. May need to create opening balance layers for existing inventory
4. Check if layers are depleted but physical inventory exists (data sync issue)

### Cost Layer Out of Sync

If cost layer quantities don't match physical inventory:

1. Run inventory reconciliation script
2. Create adjustment layers to correct discrepancies
3. Investigate why layers and physical diverged (missing movements?)
4. Audit recent movements for proper layer creation/consumption

### Performance Issues

If cost layer queries are slow:

1. Check indexes on tenant_id, item_id, location_id
2. Ensure FIFO index (with WHERE remaining_quantity > 0) is being used
3. Consider archiving fully consumed layers older than X years
4. Use materialized views for common cost calculations

## Future Enhancements

- **LIFO support**: Add costing method configuration to support Last-In-First-Out
- **Weighted average mode**: Option to use weighted average instead of FIFO
- **Specific identification**: Track serial numbers within cost layers
- **Cost adjustments**: Allow retroactive cost corrections with journal entries
- **Landed costs**: Distribute freight/duty costs across receipt layers
- **Standard cost variance**: Track difference between standard and actual costs
- **Cost roll-up**: Automated calculation of production costs from BOM costs

## Summary

The cost layer foundation provides:
- ✅ Accurate FIFO cost tracking
- ✅ True COGS calculation
- ✅ Full audit trail
- ✅ Financial compliance
- ✅ Cost traceability

All inventory operations should now create or consume cost layers to maintain accurate costing.
