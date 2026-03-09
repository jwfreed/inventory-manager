import 'dotenv/config';
import { pool } from '../src/db';
import { auditMovementHashCoverage } from '../src/modules/platform/application/inventoryMutationSupport';

function getArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const tenantId = getArg('tenant-id') ?? null;
  const sampleLimit = parsePositiveInt(getArg('sample-limit'), 25);
  const client = await pool.connect();
  try {
    const audit = await auditMovementHashCoverage(client, {
      tenantId,
      sampleLimit
    });
    console.log(JSON.stringify(audit, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
