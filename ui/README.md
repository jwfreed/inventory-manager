# React + TypeScript + Vite

## Backend connectivity

- The backend Express app mounts routes at `/` (not `/api`).
- In dev, the UI calls APIs via `/api/*` and Vite rewrites/proxies those requests to the backend (e.g., `/api/vendors` → `http://localhost:3000/vendors`).
- The Home page “API connectivity” check uses `GET /vendors` (via the proxy) because it’s a real endpoint that should exist even on an empty database.

## Backend endpoint inventory (as of aa9153e)

- Routes are mounted directly at `/` (no prefix). The proxy still uses `/api/* → /`.
- Implemented endpoints:
  - Vendors: `POST /vendors`, `GET /vendors`
  - Purchase orders: `POST /purchase-orders`, `GET /purchase-orders`, `GET /purchase-orders/:id`
  - Receipts + QC: `POST /purchase-order-receipts`, `GET /purchase-order-receipts/:id`, `POST /qc-events`, `GET /purchase-order-receipt-lines/:id/qc-events`
  - Putaways: `POST /putaways`, `GET /putaways/:id`, `POST /putaways/:id/post`
  - Closeout: `GET /purchase-order-receipts/:id/reconciliation`, `POST /purchase-order-receipts/:id/close`, `POST /purchase-orders/:id/close`
  - Inventory adjustments/counts: `POST /inventory-adjustments`, `GET /inventory-adjustments/:id`, `POST /inventory-adjustments/:id/post`, `POST /inventory-counts`, `GET /inventory-counts/:id`, `POST /inventory-counts/:id/post`
  - BOMs: `POST /boms`, `GET /boms/:id`, `GET /items/:id/boms`, `POST /boms/:id/activate`, `GET /items/:id/bom`
  - Work orders: `POST /work-orders`, `GET /work-orders`, `GET /work-orders/:id`, plus execution routes `POST /work-orders/:id/issues`, `GET /work-orders/:id/issues/:issueId`, `POST /work-orders/:id/issues/:issueId/post`, `POST /work-orders/:id/completions`, `GET /work-orders/:id/completions/:completionId`, `POST /work-orders/:id/completions/:completionId/post`, `GET /work-orders/:id/execution`
  - Order to Cash (runtime added): `POST /sales-orders`, `GET /sales-orders`, `GET /sales-orders/:id`; `POST /reservations`, `GET /reservations`, `GET /reservations/:id`; `POST /shipments`, `GET /shipments`, `GET /shipments/:id`; `POST /returns`, `GET /returns`, `GET /returns/:id`
  - Phase 0 runtime: `POST /items`, `GET /items`, `GET /items/:id`; `POST /locations`, `GET /locations`, `GET /locations/:id`; ledger browse `GET /inventory-movements`, `GET /inventory-movements/:id`, `GET /inventory-movements/:id/lines`
- DB-only (no runtime endpoints in this repo): KPI reporting (Phase 7). UI short-circuits until endpoints are added.
- Order-to-Cash docs are read-only: creation and browsing are supported, but posting shipments/returns to inventory movements is out of scope for Phase 4 UI.

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
