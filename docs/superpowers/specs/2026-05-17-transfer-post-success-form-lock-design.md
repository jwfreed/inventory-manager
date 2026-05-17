# Design: Transfer Post-Success Form Lock

**Date:** 2026-05-17  
**Status:** Approved

## Problem

After a stock transfer posts successfully, the form remains active with an enabled "Post transfer" button. The operator can accidentally re-submit the same transfer.

## Approach

Pass `isDisabled={transferMutation.isSuccess}` to `InventoryTransferForm`. The existing `isDisabled` prop already disables all inputs and the submit button. No new state, no new props, no structural changes.

## Behaviour

- **Before post:** form is fully interactive; "Post transfer" is enabled.
- **After success:** all form fields and the submit button are disabled; the success receipt ("Transfer posted", View movement, New transfer) remains visible above the form.
- **After "New transfer":** `onReset` calls `transferMutation.reset()`, which sets `isSuccess → false`, re-enabling the cleared form.

## Files changed

- `ui/src/features/inventory/pages/InventoryTransferCreatePage.tsx` — one prop change
- `ui/src/test/pages/InventoryTransferCreatePage.test.tsx` — add post-success and reset tests

## Out of scope

No backend, ledger, API, ATP, WO readiness, BOM, or adjustment changes.
