# Communication Baseline (Phase 0)

Purpose: capture requests-per-workflow, payload sizes, and latency for receiving, inventory lookup, and ship/pick before changing API shape.

## How to Collect
1. Enable structured request logging (already active via request logger).
2. Run the target workflow in the UI (receiving, inventory lookup, ship/pick).
3. Capture logs and pipe into the baseline script:

```bash
cat api.log | node scripts/comms-baseline.ts > docs/comms-baseline.results.json
```

## What to Record
- Requests per workflow
- Total payload bytes (in/out)
- Average duration per request
- Waterfall depth (by manual inspection or browser devtools)

## Results (fill after capture)
- Receiving:
- Inventory lookup:
- Ship/pick:

## Top Offenders
- Endpoint(s):
- Payload size:
- Waterfall depth:

## Targets
- Reduce waterfall depth by X
- Cap requests per workflow at Y
- Increase cache hit rate (ETag/304) to Z%
