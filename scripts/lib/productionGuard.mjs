const PRODUCTION_HOST_PATTERNS = [
  /\.rds\.amazonaws\.com$/i,
  /\.supabase\.co$/i,
  /\.neon\.tech$/i,
  /\.cloud\.timescale\.com$/i,
  /\.azure\.com$/i,
  /\.azure-databases\.com$/i,
  /\.cockroachlabs\.cloud$/i,
];

function isProductionLikeDatabaseUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const { hostname } = new URL(rawUrl);
    return PRODUCTION_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return false;
  }
}

export function assertNonProductionEnvironment(scriptName, env = process.env) {
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    throw new Error(`${scriptName} refused to run with NODE_ENV=production`);
  }
  if (isProductionLikeDatabaseUrl(env.DATABASE_URL ?? '')) {
    throw new Error(
      `${scriptName} refused to run: DATABASE_URL matches a production-like cloud hostname`
    );
  }
}

