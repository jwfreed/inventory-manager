# Real-Time Dashboard Updates via SSE Implementation

## Overview
Implemented Server-Sent Events (SSE) for real-time dashboard updates. When metrics are recalculated (via nightly job or manual trigger) or work orders are completed, connected frontend clients automatically refresh their data without manual page reload.

## Backend Changes

### 1. Event Emissions in Metrics Service
**File**: `src/services/metrics.service.ts`

Added `emitEvent()` calls after metrics are updated in the database:

- **`updateAbcClassifications()`** - Emits `metrics:updated` with metric type `abc_classification`
- **`updateSlowDeadStockFlags()`** - Emits `metrics:updated` with metric type `slow_dead_stock`
- **`storeTurnsAndDoi()`** - Emits `metrics:updated` with metric type `turns_doi`

Event payload includes:
```typescript
{
  metric: 'abc_classification' | 'slow_dead_stock' | 'turns_doi',
  itemsUpdated: number,
  windowDays?: number,
  slowThresholdDays?: number,
  deadThresholdDays?: number,
  runId?: string,
  itemsProcessed?: number,
  windowStart?: string,
  windowEnd?: string
}
```

### 2. Event Emissions in Work Order Routes
**File**: `src/routes/workOrderExecution.routes.ts`

Enhanced existing event emissions to include dashboard-specific events:

#### POST `/work-orders/:id/completions/:completionId/post`
- Existing: `inventory.work_order.completion.posted` (inventory tracking)
- **New**: `workorder:completed` (dashboard updates)

#### POST `/work-orders/:id/record-batch`
- Existing: `inventory.work_order.batch.posted` (inventory tracking)
- **New**: `workorder:completed` (dashboard updates)
- **New**: `production:changed` (production metrics updates)

Event payloads:
```typescript
// workorder:completed
{
  workOrderId: string,
  completionId?: string,
  status: string
}

// production:changed
{
  workOrderId: string,
  quantityCompleted: number
}
```

## Frontend Changes

### Updated SSE Event Handler
**File**: `ui/src/lib/useServerEvents.ts`

#### Added Event Types:
- `metrics:updated` - Metrics recalculation completed
- `production:changed` - Work order production quantity changed
- `workorder:completed` - Work order completion posted

#### Query Invalidation Logic:

**On `metrics:updated`:**
- `production-summary`
- `production-overview` (all dashboard queries)
- `abc-classification`
- `inventory-aging`
- `slow-dead-stock`
- `turns-doi`

**On `production:changed` or `workorder:completed`:**
- `production-summary`
- `production-overview` (all dashboard queries)
- `work-order` (specific work order)
- `work-order-execution` (specific work order execution)

## Event Flow

### Nightly Metrics Recalculation
```
scheduler.ts (02:00 UTC)
  → metricsRecalculation.job.ts
    → MetricsService.updateAbcClassifications()
      → emitEvent(tenantId, 'metrics:updated', {...})
    → MetricsService.updateSlowDeadStockFlags()
      → emitEvent(tenantId, 'metrics:updated', {...})
    → MetricsService.storeTurnsAndDoi()
      → emitEvent(tenantId, 'metrics:updated', {...})
  → Frontend SSE Handler
    → queryClient.invalidateQueries(['production-overview'])
    → React Query refetches data
    → UI auto-updates
```

### Work Order Completion
```
POST /work-orders/:id/completions/:completionId/post
  → postWorkOrderCompletion()
  → Update work_order_executions status to 'posted'
  → Update work_orders.quantity_completed
  → emitEvent(tenantId, 'workorder:completed', {...})
  → emitEvent(tenantId, 'production:changed', {...})
  → Frontend SSE Handler
    → queryClient.invalidateQueries(['production-overview'])
    → React Query refetches data
    → UI auto-updates
```

## Testing Steps

1. **Test Metrics Update:**
   ```bash
   # Trigger metrics job manually
   curl -X POST http://localhost:3000/metrics/job/trigger \
     -H "Authorization: Bearer YOUR_TOKEN"
   
   # Watch frontend dashboard auto-refresh
   ```

2. **Test Work Order Completion:**
   - Open Production Overview Dashboard
   - Complete a work order in another tab/browser
   - Dashboard should auto-update with new completion data

3. **Verify SSE Connection:**
   ```bash
   # Check active SSE clients
   curl http://localhost:3000/events/stats \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

## Benefits

1. **No Manual Refresh Required** - Dashboard updates automatically
2. **Multi-User Support** - All connected users see updates in real-time
3. **Tenant Isolation** - Events only sent to same tenant clients
4. **Efficient** - Only affected queries are invalidated and refetched
5. **Production Ready** - Existing SSE infrastructure proven in production

## Performance Considerations

- SSE connections are lightweight (HTTP/1.1 persistent connection)
- Events are tenant-scoped (no cross-tenant leakage)
- Query invalidation is selective (only affected data refetches)
- React Query handles deduplication and batching automatically
- No polling overhead
- Graceful fallback if SSE unavailable (manual refresh still works)

## Next Steps

Complete remaining enhancements:
- **Step 4**: Chart export to PNG/SVG functionality
- **Step 5**: Drill-down chart navigation
