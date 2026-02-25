import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { runSiamayaFactoryPack, type SeedSummary } from './packs/siamaya_factory';
import { runDemoPack } from './packs/demo';
import { seedPurchaseOrdersAndReceiptsViaApi } from './receipts/seed_purchase_orders_and_receipts';

type RunnerOptions = {
  pack: string;
  bomFilePath?: string;
  bomSheetName?: string;
  tenantSlug?: string;
  tenantName?: string;
  adminEmail?: string;
  adminPassword?: string;
  withReceipts: boolean;
  receiptMode?: 'clean' | 'partial_then_close_short' | 'partial_with_discrepancy';
  apiBaseUrl: string;
};

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`SEED_OPTION_INVALID_BOOLEAN value=${value}`);
}

function getBooleanArg(name: string, envValue: string | undefined, defaultValue: boolean): boolean {
  const inline = getArg(name);
  if (inline !== undefined) {
    return parseBoolean(inline);
  }
  if (process.argv.includes(`--${name}`)) {
    return true;
  }
  if (envValue !== undefined) {
    return parseBoolean(envValue);
  }
  return defaultValue;
}

function parseReceiptMode(value: string | undefined): 'clean' | 'partial_then_close_short' | 'partial_with_discrepancy' {
  const mode = (value ?? 'clean').trim().toLowerCase();
  if (mode === 'clean') return 'clean';
  if (mode === 'partial_then_close_short') return 'partial_then_close_short';
  if (mode === 'partial_with_discrepancy') return 'partial_with_discrepancy';
  throw new Error(`SEED_OPTION_INVALID_RECEIPT_MODE value=${value}`);
}

function parseRunnerOptions(): RunnerOptions {
  const pack = getArg('pack') ?? process.env.SEED_PACK ?? '';
  return {
    pack,
    bomFilePath: getArg('bom-file') ?? process.env.SEED_BOM_FILE,
    bomSheetName: getArg('bom-sheet') ?? process.env.SEED_BOM_SHEET,
    tenantSlug: getArg('tenant-slug') ?? process.env.SEED_TENANT_SLUG,
    tenantName: getArg('tenant-name') ?? process.env.SEED_TENANT_NAME,
    adminEmail: getArg('admin-email') ?? process.env.SEED_ADMIN_EMAIL,
    adminPassword: getArg('admin-password') ?? process.env.SEED_ADMIN_PASSWORD,
    withReceipts: getBooleanArg('with-receipts', process.env.SEED_WITH_RECEIPTS, false),
    receiptMode: parseReceiptMode(getArg('receipt-mode') ?? process.env.SEED_RECEIPT_MODE),
    apiBaseUrl: getArg('api-base-url') ?? process.env.SEED_API_BASE_URL ?? 'http://localhost:3000'
  };
}

function normalizeSummary(summary: SeedSummary): { SEED_SUMMARY: SeedSummary } {
  return {
    SEED_SUMMARY: {
      pack: summary.pack,
      tenant: summary.tenant,
      receiptMode: summary.receiptMode,
      warehousesCreated: summary.warehousesCreated,
      locationsCreated: summary.locationsCreated,
      usersUpserted: summary.usersUpserted,
      itemsUpserted: summary.itemsUpserted,
      bomsUpserted: summary.bomsUpserted,
      bomVersionsUpserted: summary.bomVersionsUpserted,
      bomLinesUpserted: summary.bomLinesUpserted,
      uomConversionsUpserted: summary.uomConversionsUpserted,
      purchaseOrdersCreated: summary.purchaseOrdersCreated,
      purchaseOrdersReused: summary.purchaseOrdersReused,
      purchaseOrderLinesCreated: summary.purchaseOrderLinesCreated,
      purchaseOrderLinesReused: summary.purchaseOrderLinesReused,
      receiptsAttempted: summary.receiptsAttempted,
      receiptsCreated: summary.receiptsCreated,
      receiptsReplayed: summary.receiptsReplayed,
      receiptLinesAttempted: summary.receiptLinesAttempted,
      lineClosuresAttempted: summary.lineClosuresAttempted,
      lineClosuresApplied: summary.lineClosuresApplied,
      lineClosuresReplayed: summary.lineClosuresReplayed,
      receiptMovementsCreated: summary.receiptMovementsCreated,
      costLayersCreatedEstimate: summary.costLayersCreatedEstimate,
      unknownUoms: [...summary.unknownUoms],
      checksum: summary.checksum
    }
  };
}

function combineChecksum(baseChecksum: string, receiptChecksumLines: string[]): string {
  if (receiptChecksumLines.length === 0) {
    return baseChecksum;
  }
  const digest = createHash('sha256')
    .update([`base:${baseChecksum}`, ...[...receiptChecksumLines].sort((left, right) => left.localeCompare(right))].join('\n'))
    .digest('hex');
  return `sha256:${digest}`;
}

export async function runSeedPack(options: RunnerOptions): Promise<SeedSummary> {
  if (!options.pack) {
    throw new Error('SEED_PACK_REQUIRED use --pack <siamaya_factory|demo>');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  const effectiveReceiptMode = parseReceiptMode(options.receiptMode);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000
  });

  try {
    let summary: SeedSummary;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

      if (options.pack === 'siamaya_factory') {
        summary = await runSiamayaFactoryPack(client, {
          pack: options.pack,
          bomFilePath: options.bomFilePath,
          bomSheetName: options.bomSheetName,
          tenantSlug: options.tenantSlug,
          tenantName: options.tenantName,
          adminEmail: options.adminEmail,
          adminPassword: options.adminPassword
        });
      } else if (options.pack === 'demo') {
        summary = await runDemoPack(client);
      } else {
        throw new Error(`SEED_PACK_UNKNOWN pack=${options.pack}`);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    if (options.withReceipts) {
      const receiptsResult = await seedPurchaseOrdersAndReceiptsViaApi({
        pool,
        pack: options.pack,
        tenantSlug: summary.tenant,
        receiptMode: effectiveReceiptMode,
        apiBaseUrl: options.apiBaseUrl,
        adminEmail: options.adminEmail ?? 'jon.freed@gmail.com',
        adminPassword: options.adminPassword ?? 'admin@local'
      });

      summary = {
        ...summary,
        receiptMode: effectiveReceiptMode,
        purchaseOrdersCreated: receiptsResult.purchaseOrdersCreated,
        purchaseOrdersReused: receiptsResult.purchaseOrdersReused,
        purchaseOrderLinesCreated: receiptsResult.purchaseOrderLinesCreated,
        purchaseOrderLinesReused: receiptsResult.purchaseOrderLinesReused,
        receiptsAttempted: receiptsResult.receiptsAttempted,
        receiptsCreated: receiptsResult.receiptsCreated,
        receiptsReplayed: receiptsResult.receiptsReplayed,
        receiptLinesAttempted: receiptsResult.receiptLinesAttempted,
        lineClosuresAttempted: receiptsResult.lineClosuresAttempted,
        lineClosuresApplied: receiptsResult.lineClosuresApplied,
        lineClosuresReplayed: receiptsResult.lineClosuresReplayed,
        receiptMovementsCreated: receiptsResult.receiptMovementsCreated,
        costLayersCreatedEstimate: receiptsResult.costLayersCreatedEstimate,
        checksum: combineChecksum(summary.checksum, receiptsResult.checksumLines)
      };
    }

    return summary;
  } finally {
    await pool.end();
  }
}

async function main() {
  const options = parseRunnerOptions();
  const summary = await runSeedPack(options);
  console.log(JSON.stringify(normalizeSummary(summary), null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    if (error instanceof Error) {
      const message = error.message || (error as any).code || String(error);
      console.error(message);
    } else {
      console.error(error);
    }
    process.exit(1);
  });
}
