export async function swallowFailure(): Promise<void> {
  try {
    await Promise.resolve();
  } catch {}
}
