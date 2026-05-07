export async function pollForever(): Promise<void> {
  while (true) {
    await Promise.resolve();
  }
}
