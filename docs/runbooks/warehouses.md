# Warehouses Runbook

This system models warehouses as **location roots**, not a separate table. A valid warehouse hierarchy is required for defaults, ATP, reservations, and QC flows.

## Warehouse Hierarchy Rules

**Warehouse root (type = `warehouse`):**
- `role` **must be NULL**
- `is_sellable` **must be false**
- `parent_location_id` **must be NULL**
- `warehouse_id` **must equal its own id**

**Role bins (children of root):**
- Roles: `SELLABLE`, `QA`, `HOLD`, `REJECT`, `SCRAP`
- Must be direct children of the root
- Must have `warehouse_id = root.id`
- Must have `type = 'bin'`

## Defaults

Each warehouse must have a default location for:
- `SELLABLE`
- `QA`
- `HOLD`
- `REJECT`

Defaults are stored in `warehouse_default_location` and **must never cross warehouses**.

## Standard Template

Always provision warehouses using the standard template endpoint:

```bash
POST /locations/templates/standard-warehouse
```

This endpoint is idempotent and creates:
- A warehouse root
- Required role bins
- Default mappings

**Do not** manually insert roots or bins in API tests or ops workflows. Use the template.

## Reparenting Rules (Phase 6)

- Reparents are serialized per tenant using advisory locks.
- Cascade updates to descendants are capped at 1000 nodes.
- Reparent fails if default locations are in the moved subtree and the warehouse would change.
- Reparent is blocked entirely if `WAREHOUSE_ID_DRIFT` exists for that tenant.

## Common Failures

- `WAREHOUSE_ROOT_INVALID`: root created with a role or `is_sellable=true`.
- `WAREHOUSE_DEFAULT_LOCATION_INVALID`: defaults point outside the warehouse or at the root.
- `CASCADE_SIZE_EXCEEDED`: subtree > 1000 nodes.
- `CASCADE_LOCK_CONFLICT`: a descendant row is locked in another transaction.

## Related Docs

- Invariants: `docs/runbooks/invariants.md`
- Debugging tests: `docs/runbooks/debugging_tests.md`
