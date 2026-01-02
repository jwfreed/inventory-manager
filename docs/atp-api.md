# ATP (Available to Promise) Implementation

## Overview

The ATP service provides focused queries to determine Available to Promise inventory, calculated as:

```
ATP = on_hand - reserved
```

Where:
- **on_hand**: Current inventory from posted inventory movements
- **reserved**: Open/released reservations from sales orders or other demand

## API Endpoints

### 1. GET /atp
Query ATP across items and locations with optional filters.

**Query Parameters:**
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
      "availableToPromise": 75
    }
  ]
}
```

**Example:**
```bash
GET /atp?itemId=123e4567-e89b-12d3-a456-426614174000&limit=10
```

---

### 2. GET /atp/detail
Get ATP for a specific item/location/uom combination.

**Query Parameters:**
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
    "availableToPromise": 75
  }
}
```

**Example:**
```bash
GET /atp/detail?itemId=123e4567-e89b-12d3-a456-426614174000&locationId=234e5678-e89b-12d3-a456-426614174000&uom=EA
```

---

### 3. POST /atp/check
Check if sufficient ATP exists for a requested quantity.

**Request Body:**
```json
{
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

### `getAvailableToPromiseDetail(tenantId, itemId, locationId, uom?)`
Get ATP for a specific item/location, returns null if no inventory found.

### `checkAtpSufficiency(tenantId, itemId, locationId, uom, requestedQuantity)`
Validates if sufficient ATP exists for the requested quantity.

## Database Logic

ATP calculation uses two CTEs:
1. **on_hand**: Aggregates `quantity_delta` from `inventory_movement_lines` where `inventory_movements.status = 'posted'`
2. **reserved**: Aggregates `quantity_reserved - quantity_fulfilled` from `inventory_reservations` where `status IN ('open', 'released')`

The final calculation is: `on_hand - reserved = availableToPromise`

## Use Cases

1. **Order Promising**: Before accepting a sales order, check ATP to ensure inventory availability
2. **Reservation Validation**: Validate reservation requests don't exceed available inventory
3. **Inventory Planning**: Identify items with negative ATP (over-reserved situations)
4. **Fulfillment Optimization**: Find locations with sufficient ATP for picking operations

## Relationship to Other Services

- **inventory_snapshot**: Provides comprehensive inventory status including held, rejected, on-order, etc.
- **ATP**: Focused specifically on available-to-promise calculation (on_hand - reserved)
- **inventory_reservations**: Source of reserved quantities that reduce ATP
- **inventory_movement_lines**: Source of on-hand quantities that contribute to ATP

Use ATP endpoints for fast, focused queries when you only need to know what's available to promise. Use inventory_snapshot for comprehensive inventory analysis including quality hold status, in-transit, etc.
