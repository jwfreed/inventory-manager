import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBomGraph, validateBomDataset } from './generate_simulation_assets.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOM_PATH = path.resolve(__dirname, 'siamaya-bom-production.json');
const REPORT_PATH = path.resolve(__dirname, 'bom-validation-report.json');

function main() {
  const bomDocument = JSON.parse(fs.readFileSync(BOM_PATH, 'utf8'));
  const report = validateBomDataset(bomDocument, buildBomGraph(bomDocument));
  if (process.argv.includes('--write')) {
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.valid) {
    process.exitCode = 1;
  }
}

main();
