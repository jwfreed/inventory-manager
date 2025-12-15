#!/usr/bin/env python3
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path

MIG_DIR = Path("src/migrations")

pat = re.compile(r"^(\d{14})_(.+)\.ts$")

files = sorted([p for p in MIG_DIR.iterdir() if p.suffix == ".ts"])

renames = []
sql_updates = []

for p in files:
    m = pat.match(p.name)
    if not m:
        # skip anything not matching your current 14-digit format
        continue

    ymdhms, rest = m.group(1), m.group(2)

    # interpret your 14-digit timestamp as UTC (consistent + deterministic)
    dt = datetime.strptime(ymdhms, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    unix_ms = int(dt.timestamp() * 1000)

    old_base = p.stem  # without .ts
    new_base = f"{unix_ms}_{rest}"
    new_name = f"{new_base}.ts"

    if new_name == p.name:
        continue

    renames.append((p, MIG_DIR / new_name))
    sql_updates.append((old_base, new_base))

print("# mv commands:")
for oldp, newp in renames:
    print(f"mv {oldp.as_posix()} {newp.as_posix()}")

print("\n# SQL updates for inventory_schema_migrations (run these in psql):")
for old_base, new_base in sql_updates:
    print(
        f"update inventory_schema_migrations set name='{new_base}' where name='{old_base}';"
    )
