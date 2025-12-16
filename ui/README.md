# React + TypeScript + Vite

## Backend connectivity

- The backend Express app mounts routes at `/` (not `/api`).
- In dev, the UI calls APIs via `/api/*` and Vite rewrites/proxies those requests to the backend (e.g., `/api/vendors` → `http://localhost:3000/vendors`).
- The Home page “API connectivity” check uses `GET /vendors` (via the proxy) because it’s a real endpoint that should exist even on an empty database.

## UI ↔ API wiring (as of main)

- Routes are mounted at `/`; the UI calls `/api/*` which the Vite proxy rewrites to `/`.
- UI endpoints in use:
  - Items: `GET /items`, `GET /items/:id`; optional inventory summary `GET /items/:id/inventory` (shows EmptyState on 404).
  - Locations: `GET /locations`, `GET /locations/:id`; optional inventory summary `GET /locations/:id/inventory`.
  - Ledger: `GET /inventory-movements`, `GET /inventory-movements/:id`, `GET /inventory-movements/:id/lines`.
  - Work orders: `GET /work-orders`, `GET /work-orders/:id`, `GET /work-orders/:id/execution`, `POST /work-orders/:id/issues`, `POST /work-orders/:id/issues/:issueId/post`, `POST /work-orders/:id/completions`, `POST /work-orders/:id/completions/:completionId/post`.
  - Order-to-Cash (docs only): `GET /sales-orders`, `GET /sales-orders/:id`, `GET /reservations`, `GET /reservations/:id`, `GET /shipments`, `GET /shipments/:id`, `GET /returns`, `GET /returns/:id`. Creation uses the same base paths via POST where forms exist.
  - KPI storage: `GET /kpis/snapshots`, `GET /kpis/runs` (read-only dashboard; no KPI computation in UI).
- Missing/optional APIs:
  - Inventory summaries are optional helpers; UI handles 404/500 with EmptyState.
  - No posting endpoints for shipments/returns; UI does not attempt them.

## Backend smoke tests (Phase 4 runtime)

Run with the API server running (proxy via `/api/*` is fine):

```bash
# Sales order (draft)
curl -X POST http://localhost:3000/sales-orders \
  -H "Content-Type: application/json" \
  -d '{"soNumber":"SO-1001","customerId":"<customer_uuid>","orderDate":"2024-01-01","lines":[{"itemId":"<item_uuid>","uom":"ea","quantityOrdered":2}]}'
curl http://localhost:3000/sales-orders

# Reservation (no movements created)
curl -X POST http://localhost:3000/reservations \
  -H "Content-Type: application/json" \
  -d '{"reservations":[{"demandType":"sales_order_line","demandId":"<so_line_uuid>","itemId":"<item_uuid>","locationId":"<location_uuid>","uom":"ea","quantityReserved":1}]}'
psql "$DATABASE_URL" -c "select count(*) from inventory_movements where external_ref like 'reservation%';"

# Shipment (doc only)
curl -X POST http://localhost:3000/shipments \
  -H "Content-Type: application/json" \
  -d '{"salesOrderId":"<so_uuid>","shippedAt":"2024-01-02T12:00:00Z","lines":[{"salesOrderLineId":"<so_line_uuid>","uom":"ea","quantityShipped":1}]}'
curl http://localhost:3000/shipments

# Return authorization (RMA)
curl -X POST http://localhost:3000/returns \
  -H "Content-Type: application/json" \
  -d '{"rmaNumber":"RMA-1","customerId":"<customer_uuid>","salesOrderId":"<so_uuid>","lines":[{"itemId":"<item_uuid>","uom":"ea","quantityAuthorized":1}]}'
curl http://localhost:3000/returns

# Phase 0 basics
curl -X POST http://localhost:3000/items -H "Content-Type: application/json" -d '{"sku":"SKU-1","name":"Widget"}'
curl http://localhost:3000/items
curl -X POST http://localhost:3000/locations -H "Content-Type: application/json" -d '{"code":"LOC-1","name":"Main","type":"warehouse"}'
curl http://localhost:3000/locations
# After creating an adjustment/receipt, browse ledger:
curl http://localhost:3000/inventory-movements
curl http://localhost:3000/inventory-movements/<movement_id>
curl http://localhost:3000/inventory-movements/<movement_id>/lines

# Inventory summaries (ledger-derived, read-only)
# Item summary (empty until movements exist)
curl http://localhost:3000/items/<item_id>/inventory
# Location summary
curl http://localhost:3000/locations/<location_id>/inventory
psql "$DATABASE_URL" -c "select item_id, location_id, quantity_delta from inventory_movement_lines limit 5;"
echo "These summaries sum posted movement lines and are not an authority; inventory_movements remains the source of truth."

# Phase 4 — Picking
curl -X POST http://localhost:3000/pick-batches -H "Content-Type: application/json" -d '{"pickType":"single_order","status":"draft"}'
curl http://localhost:3000/pick-batches
curl -X POST http://localhost:3000/pick-tasks -H "Content-Type: application/json" -d '{"pickBatchId":"<batch_id>","itemId":"<item_uuid>","uom":"ea","fromLocationId":"<loc_uuid>","quantityRequested":1}'
curl http://localhost:3000/pick-tasks

# Phase 4 — Packing
curl -X POST http://localhost:3000/packs -H "Content-Type: application/json" -d '{"salesOrderShipmentId":"<shipment_id>","status":"open","lines":[{"salesOrderLineId":"<so_line_id>","itemId":"<item_id>","uom":"ea","quantityPacked":1}]}'
curl http://localhost:3000/packs
curl http://localhost:3000/packs/<pack_id>

# Phase 4 — Return receipts & dispositions
curl -X POST http://localhost:3000/return-receipts -H "Content-Type: application/json" -d '{"returnAuthorizationId":"<rma_id>","receivedAt":"2024-01-01T00:00:00Z","receivedToLocationId":"<loc_id>","lines":[{"itemId":"<item_id>","uom":"ea","quantityReceived":1}]}'
curl http://localhost:3000/return-receipts
curl -X POST http://localhost:3000/return-dispositions -H "Content-Type: application/json" -d '{"returnReceiptId":"<receipt_id>","occurredAt":"2024-01-02T00:00:00Z","dispositionType":"restock","fromLocationId":"<loc_id>","lines":[{"itemId":"<item_id>","uom":"ea","quantity":1}]}'
curl http://localhost:3000/return-dispositions
```

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
