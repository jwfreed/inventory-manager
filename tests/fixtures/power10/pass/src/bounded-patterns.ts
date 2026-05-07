async function boundedRetry(retries: number): Promise<void> {
  let attempt = 0;

  while (true) {
    attempt = attempt + 1;
    try {
      await Promise.resolve();
      return;
    } catch (error) {
      if (attempt < retries) {
        continue;
      }
      throw error;
    }
  }
}

async function annotatedLoop(): Promise<void> {
  // power10: bounded-loop -- exits when the page source is exhausted.
  while (true) {
    const rows: unknown[] = [];
    if (rows.length === 0) break;
  }
}

async function intentionalEmptyCatch(): Promise<void> {
  try {
    await Promise.resolve();
  } catch {
    // power10: intentional-empty-catch -- best-effort cleanup has no observable recovery path.
  }
}

async function boundedBatch(rows: unknown[]): Promise<void[]> {
  // power10: bounded-batch -- fixture rows are capped by the caller at 10 entries.
  return Promise.all(rows.map(async () => undefined));
}

async function useAll(): Promise<void> {
  await boundedRetry(3);
  await annotatedLoop();
  await intentionalEmptyCatch();
  await boundedBatch([]);
}

void useAll;
