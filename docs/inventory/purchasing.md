# Purchasing Lifecycle (PO + Receiving)

## Partial Receiving
- Partial receipts are allowed without `discrepancyReason` while the PO line remains `open`.
- Receipt posting remains ledger-authoritative and idempotent via `Idempotency-Key`.

## When `discrepancyReason` Is Required
- Over-receipt (`cumulative received > ordered`) requires:
  - `overReceiptApproved=true`
  - `discrepancyReason="over"`
- Without both fields, the API fails loud (`RECEIPT_OVERRECEIPT_NOT_APPROVED` / `RECEIPT_OVERRECEIPT_REASON_REQUIRED`).

## Explicit Close Actions
- Close line: `POST /purchase-order-lines/:id/close`
  - Body: `{ closeAs: "short" | "cancelled", reason, notes?, idempotencyKey? }`
  - Closed lines reject future receipts (`RECEIPT_PO_LINE_CLOSED`).
- Close PO: `POST /purchase-orders/:id/close`
  - Body: `{ closeAs: "closed" | "cancelled", reason, notes?, idempotencyKey? }`
  - `closeAs="closed"` closes remaining open lines as short.
  - `closeAs="cancelled"` is blocked if posted receipts already exist.

## Audit + Determinism
- Close endpoints are idempotent and emit structured events:
  - `purchase_order.line.closed`
  - `purchase_order.closed`
- Close actions do not post inventory movements and do not mutate ledger history.
