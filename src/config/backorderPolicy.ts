export type BackorderPolicy = {
  enableBackorders: boolean;
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return fallback;
}

export function getBackorderPolicy(): BackorderPolicy {
  return {
    enableBackorders: parseBoolean(process.env.ENABLE_BACKORDERS, true)
  };
}
