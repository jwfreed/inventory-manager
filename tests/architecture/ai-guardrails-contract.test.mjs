import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

const REQUIRED_FILES = [
  '.repo/ai-engineering-contract.md',
  '.github/copilot-instructions.md',
  'docs/engineering/ai-development.md'
];

test('AI guardrail files exist and encode the repository safety contract', async () => {
  for (const relativePath of REQUIRED_FILES) {
    const absolutePath = path.resolve(process.cwd(), relativePath);
    const fileStat = await stat(absolutePath);
    assert.equal(fileStat.isFile(), true, `${relativePath} must exist`);
  }

  const engineeringContract = await readFile(path.resolve(process.cwd(), '.repo/ai-engineering-contract.md'), 'utf8');
  const copilotInstructions = await readFile(path.resolve(process.cwd(), '.github/copilot-instructions.md'), 'utf8');
  const aiDevelopmentDoc = await readFile(path.resolve(process.cwd(), 'docs/engineering/ai-development.md'), 'utf8');

  assert.match(engineeringContract, /append-only/i);
  assert.match(engineeringContract, /withTransaction|withTransactionRetry/);
  assert.match(engineeringContract, /createInventoryMovement|ledgerWriter/);
  assert.match(engineeringContract, /schema/i);
  assert.match(engineeringContract, /truth/i);
  assert.match(engineeringContract, /contracts/i);
  assert.match(engineeringContract, /scenarios/i);

  assert.match(copilotInstructions, /do not bypass/i);
  assert.match(copilotInstructions, /inventory_movements/i);
  assert.match(copilotInstructions, /createInventoryMovement|ledgerWriter/);
  assert.match(copilotInstructions, /withTransaction|withTransactionRetry/);

  assert.match(aiDevelopmentDoc, /AI-assisted development/i);
  assert.match(aiDevelopmentDoc, /deterministic/i);
  assert.match(aiDevelopmentDoc, /schema/i);
  assert.match(aiDevelopmentDoc, /test:truth/i);
});

test('.repo/prompts includes reusable prompt templates for safe AI changes', async () => {
  const promptsDir = path.resolve(process.cwd(), '.repo/prompts');
  const entries = await readdir(promptsDir);
  const markdownFiles = entries.filter((entry) => entry.endsWith('.md')).sort();

  assert.ok(markdownFiles.length >= 3, 'expected at least three prompt templates under .repo/prompts');

  for (const entry of markdownFiles) {
    const contents = await readFile(path.join(promptsDir, entry), 'utf8');
    assert.match(contents, /ledger|invariant|deterministic|schema/i, `${entry} must describe safety constraints`);
  }
});
