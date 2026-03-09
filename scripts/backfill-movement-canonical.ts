async function main() {
  throw new Error(
    'LEDGER_APPEND_ONLY_ENFORCED: inventory_movement_lines is immutable. This backfill script is retired; use reversal movements for corrective postings instead of in-place UPDATE.'
  );
}

main().catch((err) => {
  console.error('[backfill] failed', err);
  process.exit(1);
});
