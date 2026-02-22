type StartupModeOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  nodeEnv?: string;
};

export const WAREHOUSE_DEFAULTS_REPAIR_HINT =
  'Run with --repair-defaults or set WAREHOUSE_DEFAULTS_REPAIR=true to auto-repair warehouse defaults (local/dev only).';

const HINT_ELIGIBLE_DEFAULTS_ERROR_CODES = new Set([
  'WAREHOUSE_DEFAULT_INVALID',
  'WAREHOUSE_DEFAULT_LOCATIONS_REQUIRED'
]);

export type WarehouseDefaultsStartupMode = {
  cliRepairDefaults: boolean;
  startupRepairMode: boolean | undefined;
  defaultsRepairEnv: string | undefined;
};

function isTruthyValue(value: string | undefined): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function hasBooleanCliFlag(name: string, argv: string[] = process.argv): boolean {
  const direct = `--${name}`;
  const normalized = argv.find((arg) => arg === direct || arg.startsWith(`${direct}=`));
  if (!normalized) return false;
  if (normalized === direct) return true;
  const value = normalized.split('=')[1]?.trim().toLowerCase();
  return isTruthyValue(value);
}

export function resolveWarehouseDefaultsStartupMode(
  options: StartupModeOptions = {}
): WarehouseDefaultsStartupMode {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const nodeEnv = options.nodeEnv ?? env.NODE_ENV;
  const cliRepairDefaults = hasBooleanCliFlag('repair-defaults', argv);
  const devAutoRepairDefaults = isTruthyValue(env.DEV_AUTO_REPAIR_DEFAULTS);
  const hasExplicitRepairEnv = typeof env.WAREHOUSE_DEFAULTS_REPAIR !== 'undefined';

  if (cliRepairDefaults) {
    env.WAREHOUSE_DEFAULTS_REPAIR = 'true';
  } else if (!hasExplicitRepairEnv && nodeEnv === 'development' && devAutoRepairDefaults) {
    // Local development opt-in: explicit env toggle enables auto-repair without CLI flags.
    env.WAREHOUSE_DEFAULTS_REPAIR = 'true';
  } else if (!hasExplicitRepairEnv && nodeEnv !== 'test') {
    // Production/staging/dev default remains fail-loud unless explicitly opted in.
    env.WAREHOUSE_DEFAULTS_REPAIR = 'false';
  }

  return {
    cliRepairDefaults,
    startupRepairMode: cliRepairDefaults ? true : undefined,
    defaultsRepairEnv: env.WAREHOUSE_DEFAULTS_REPAIR
  };
}

function isRepairEnabled(env: NodeJS.ProcessEnv): boolean {
  return isTruthyValue(env.WAREHOUSE_DEFAULTS_REPAIR);
}

function withDefaultsRepairHint(
  code: string | null,
  details: unknown,
  env: NodeJS.ProcessEnv
): unknown {
  if (!code || !HINT_ELIGIBLE_DEFAULTS_ERROR_CODES.has(code)) return details;
  if (isRepairEnabled(env)) return details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const candidate = details as Record<string, unknown>;
    if (typeof candidate.hint === 'string' && candidate.hint.trim().length > 0) return details;
    return { ...candidate, hint: WAREHOUSE_DEFAULTS_REPAIR_HINT };
  }
  return { hint: WAREHOUSE_DEFAULTS_REPAIR_HINT };
}

export function buildStructuredStartupError(
  error: unknown,
  options: { env?: NodeJS.ProcessEnv } = {}
): { code: string | null; details: unknown | null } {
  const candidate = (error ?? {}) as { code?: unknown; details?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : null;
  const env = options.env ?? process.env;
  return {
    code,
    details: withDefaultsRepairHint(code, candidate.details ?? null, env)
  };
}

export function logStructuredStartupFailure(
  error: unknown,
  logger: (message: string) => void = (message) => console.error(message),
  options: { env?: NodeJS.ProcessEnv } = {}
): void {
  const structured = buildStructuredStartupError(error, options);
  if (structured.code || structured.details) {
    logger(`Startup failed structured: ${JSON.stringify(structured)}`);
  }
}
