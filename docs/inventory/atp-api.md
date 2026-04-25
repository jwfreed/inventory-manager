# ATP (Available to Promise) Implementation

## Overview

The ATP service provides focused queries to determine Available to Promise inventory, calculated as:

```
ATP = on_hand - reserved - allocated
```

Where:
- **on_hand**: Net posted inventory movement quantity (`SUM(COALESCE(quantity_delta_canonical, quantity_delta))`)
- **reserved**: Open commitment from reservations in `RESERVED` state
- **allocated**: Open commitment from reservations in `ALLOCATED` state

## API Endpoints

### 1. GET /atp
Query ATP across items and locations with optional filters.

**Query Parameters:**
- `warehouseId` (**required**): Warehouse UUID
- `itemId` (optional): Filter by specific item UUID
- `locationId` (optional): Filter by specific location UUID
- `limit` (optional): Max results (default 500, max 1000)
- `offset` (optional): Pagination offset

**Response:**
```json
{
  "data": [
    {
      "itemId": "uuid",
      "locationId": "uuid",
      "uom": "EA",
      "onHand": 100,
      "reserved": 25,
      "allocated": 10,
      "availableToPromise": 65
    }
  ]
}
```

**Example:**
```bash
GET /atp?warehouseId=<WAREHOUSE_UUID>&itemId=123e4567-e89b-12d3-a456-426614174000&limit=10
```

---

### 2. GET /atp/detail
Get ATP for a specific item/location/uom combination.

**Query Parameters:**
- `warehouseId` (required): Warehouse UUID
- `itemId` (required): Item UUID
- `locationId` (required): Location UUID
- `uom` (optional): Unit of measure

**Response:**
```json
{
  "data": {
    "itemId": "uuid",
    "locationId": "uuid",
    "uom": "EA",
    "onHand": 100,
    "reserved": 25,
    "allocated": 10,
    "availableToPromise": 65
  }
}
```

**Example:**
```bash
GET /atp/detail?warehouseId=<WAREHOUSE_UUID>&itemId=123e4567-e89b-12d3-a456-426614174000&locationId=234e5678-e89b-12d3-a456-426614174000&uom=EA
```

---

### 3. POST /atp/check
Check if sufficient ATP exists for a requested quantity.

**Request Body:**
```json
{
  "warehouseId": "uuid",
  "itemId": "uuid",
  "locationId": "uuid",
  "uom": "EA",
  "quantity": 50
}
```

**Response:**
```json
{
  "data": {
    "sufficient": true,
    "atp": 75,
    "requested": 50
  }
}
```

**Example:**
```bash
POST /atp/check
Content-Type: application/json

{
  "itemId": "123e4567-e89b-12d3-a456-426614174000",
  "locationId": "234e5678-e89b-12d3-a456-426614174000",
  "uom": "EA",
  "quantity": 50
}
```

## Service Functions

### `getAvailableToPromise(tenantId, params)`
Query ATP across multiple items/locations with filtering and pagination.

### `getAvailableToPromiseDetail(tenantId, warehouseId, itemId, locationId, uom?)`
Get ATP for a specific item/location, returns null if no inventory found.

### `checkAtpSufficiency(tenantId, warehouseId, itemId, locationId, uom, requestedQuantity)`
Validates if sufficient ATP exists for the requested quantity.

## Database Logic

ATP reads from SELLABLE availability views:

- `inventory_available_location_sellable_v` (location-grain)
- `inventory_available_sellable_v` (warehouse aggregate)

Base components are derived from:

1. **on_hand** from posted ledger lines (`inventory_on_hand_location_v` / `inventory_on_hand_v`)
2. **commitments** from reservations (`inventory_commitments_location_v` / `inventory_commitments_v`)
   - `RESERVED` contributes to `reserved_qty`
   - `ALLOCATED` contributes to `allocated_qty`
   - terminal states contribute to neither

Final formula: `available = on_hand - reserved - allocated`

## Use Cases

1. **Order Promising**: Before accepting a sales order, check ATP to ensure inventory availability
2. **Reservation Validation**: Validate reservation requests against canonical available quantity
3. **Inventory Planning**: Identify items with negative ATP (over-reserved situations)
4. **Fulfillment Optimization**: Find locations with sufficient ATP for picking operations

## Relationship to Other Services

- **inventory_snapshot**: Provides comprehensive inventory status including held, rejected, on-order, etc.
- **ATP**: Focused specifically on available-to-promise calculation (`on_hand - reserved - allocated`)
- **inventory_reservations**: Source of reserved and allocated commitments
- **inventory_movement_lines**: Source of on-hand quantities that contribute to ATP

Use ATP endpoints for fast, focused queries when you only need to know what's available to promise. Use inventory_snapshot for comprehensive inventory analysis including quality hold status, in-transit, etc.
