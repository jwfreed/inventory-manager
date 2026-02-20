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

## Canonical Topology (Phase 2.1)

Canonical warehouse roots:

- `FACTORY`
- `STORE_FACTORY`
- `STORE_THAPAE`
- `STORE_AIRPORT`
- `STORE_ONENIMMAN`

Canonical topology definitions live in:

- `seeds/topology/warehouses.tsv`
- `seeds/topology/locations.tsv`
- `seeds/topology/warehouse_defaults.tsv`

Code scope:

- `locations.code` is the canonical identifier (`UNIQUE (tenant_id, code)`), not global.
- `locations.local_code` is the warehouse label (`UNIQUE (tenant_id, warehouse_id, local_code)` when non-null).
- Example: `code=STORE_THAPAE_SELLABLE`, `local_code=SELLABLE`.

Provisioning is deterministic and idempotent:

```bash
npm run seed:warehouse-topology -- --tenant-id <TENANT_UUID>
npm run seed:warehouse-topology -- --tenant-id <TENANT_UUID> --fix
```

- Default mode is check-only (no writes).
- `--fix` is conservative repair (create-only + invalid-default repair).
- If multiple candidate bins exist for the same role in one warehouse, `--fix` fails with `WAREHOUSE_ROLE_AMBIGUOUS`; resolve manually before rerunning.

## Standard Template (API)

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
- Topology reference: `docs/warehouse-topology.md`
