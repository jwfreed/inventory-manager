export async function rebuildRows(rows: string[]): Promise<string[]> {
  return Promise.all(rows.map(async (row) => row));
}
