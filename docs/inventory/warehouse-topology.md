# Warehouse Topology (Phase 2.1)

Warehouse provisioning is deterministic and tenant-scoped.

## Code Uniqueness Scope

- `locations.code` is the canonical system identifier and is unique per tenant: `UNIQUE (tenant_id, code)`.
- `locations.local_code` is the warehouse-facing bin label and is unique per warehouse: `UNIQUE (tenant_id, warehouse_id, local_code) WHERE local_code IS NOT NULL`.
- Canonical topology uses warehouse-qualified `code` values (for example `STORE_THAPAE_SELLABLE`) while keeping shared `local_code` labels (for example `SELLABLE`) across warehouses.
- Location resolution in topology/default flows is tenant-scoped and warehouse-validated (`warehouse_default_location` + `resolve_warehouse_for_location`), never cross-tenant.

## Canonical Warehouse Codes

- `FACTORY`
- `STORE_FACTORY`
- `STORE_THAPAE`
- `STORE_AIRPORT`
- `STORE_ONENIMMAN`

Warehouse roots are `locations` rows with:

- `type = 'warehouse'`
- `role IS NULL`
- `is_sellable = false`
- `parent_location_id IS NULL`
- `warehouse_id = id`

## Canonical Location Topology

Topology sources of truth:

- `seeds/topology/warehouses.tsv`
- `seeds/topology/locations.tsv`
- `seeds/topology/warehouse_defaults.tsv`

Factory includes deterministic operational bins:

- `RAW_MATERIALS`
- `PACKAGING_MATERIALS`
- `BASE_CHOCOLATE`
- `TEMPERING_PACKAGING`
- `QA`
- `SELLABLE`
- `HOLD`
- `REJECT`
- `SCRAP`

Each store includes deterministic role bins:

- `SELLABLE`
- `QA`
- `HOLD`
- `REJECT`
- `SCRAP`

## Required Defaults

Each warehouse must have default mappings in `warehouse_default_location` for:

- `SELLABLE`
- `QA`
- `HOLD`
- `REJECT`

`SCRAP` is also seeded as a deterministic default.

## Seed Script

Run in check-only mode by default (no writes). Use `--fix` for conservative repair.

```bash
npm run seed:warehouse-topology -- --tenant-id <TENANT_UUID>
npm run seed:warehouse-topology -- --tenant-id <TENANT_UUID> --fix
```

Behavior:

- check mode: validates topology/default drift and fails fast when drift exists
- `--fix` mode (single serializable tx + advisory lock):
  - create missing canonical warehouses
  - create missing canonical locations/bins
  - set missing defaults and repair invalid defaults
  - set `local_code` only when canonical location has `local_code IS NULL`
- guardrails: never delete rows, never mutate canonical `code`, never override valid defaults
- ambiguity guardrail: if a warehouse has multiple valid candidates for the same role (for example two SELLABLE bins), `--fix` fails with `WAREHOUSE_ROLE_AMBIGUOUS` and requires manual cleanup.

## Invariants Check

`inventory_invariants_check.mjs` includes:

- `warehouse_topology_defaults_invalid`

Non-zero count indicates missing or invalid canonical warehouses, locations, or defaults.
