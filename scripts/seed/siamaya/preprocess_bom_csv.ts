import fs from 'node:fs';
import path from 'node:path';

type FocusedAssetsModule = {
  generateSimulationAssets: (options?: { sourceFile?: string }) => {
    bomDocument: unknown;
    bomSanityReport: unknown;
  };
  writeSimulationAssets: (options?: { sourceFile?: string }) => unknown;
};

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

async function main(): Promise<void> {
  const sourceFile = path.resolve(getArg('input') ?? path.resolve(process.cwd(), 'docs/3. bom-Table 1.csv'));
  const outputFile = getArg('output') ? path.resolve(getArg('output')!) : null;
  const module = (await import('./focused_75g_assets.mjs')) as FocusedAssetsModule;

  if (!fs.existsSync(sourceFile)) {
    throw new Error(`SEED_BOM_PREPROCESS_SOURCE_NOT_FOUND file=${sourceFile}`);
  }

  if (process.argv.includes('--write')) {
    module.writeSimulationAssets({ sourceFile });
  }

  const assets = module.generateSimulationAssets({ sourceFile });
  if (outputFile) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${JSON.stringify(assets.bomDocument, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(
    `${JSON.stringify({
      code: 'SIAMAYA_BOM_PREPROCESS_SUMMARY',
      sourceFile,
      outputFile,
      retainedFinishedSkuCount: (assets.bomDocument as { normalization?: { scope?: { retainedFinishedSkus?: unknown[] } } })
        ?.normalization?.scope?.retainedFinishedSkus?.length ?? 0,
      sanityFatalCount: (assets.bomSanityReport as { summary?: { fatalCount?: number } })?.summary?.fatalCount ?? 0
    })}\n`
  );
}

main().catch((error) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
