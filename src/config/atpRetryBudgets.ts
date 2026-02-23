export const ATP_RETRY_BUDGET_DEFAULTS = Object.freeze({
  serializableRetries: 2,
  reservationCreateRetries: 6
});

export const ATP_RETRY_BUDGET_PROD_CAPS = Object.freeze({
  serializableRetries: 5,
  reservationCreateRetries: 20
});

const ATP_RETRY_BUDGETS_LOG_ONCE_KEY = Symbol.for('siamaya.atpRetryBudgetsLogged');

type ResolveAtpRetryBudgetOptions = {
  env?: NodeJS.ProcessEnv;
  enforceProductionCaps?: boolean;
};

export type AtpRetryBudgets = {
  nodeEnv: string;
  serializableRetries: number;
  reservationCreateRetries: number;
  defaultsUsed: {
    serializableRetries: boolean;
    reservationCreateRetries: boolean;
  };
};

type ParsedRetryBudget = {
  value: number;
  usedDefault: boolean;
};

function buildStructuredError(
  code: string,
  details: Record<string, unknown>
): Error & { code: string; details: Record<string, unknown> } {
  const error = new Error(code) as Error & { code: string; details: Record<string, unknown> };
  error.code = code;
  error.details = details;
  return error;
}

function parseNonNegativeIntegerBudget(
  env: NodeJS.ProcessEnv,
  envName: string,
  fallback: number
): ParsedRetryBudget {
  const raw = env[envName];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return {
      value: fallback,
      usedDefault: true
    };
  }

  const normalized = String(raw).trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw buildStructuredError('ATP_RETRY_BUDGETS_INVALID', {
      field: envName,
      value: raw,
      reason: 'not_integer'
    });
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw buildStructuredError('ATP_RETRY_BUDGETS_INVALID', {
      field: envName,
      value: raw,
      reason: 'must_be_non_negative_integer'
    });
  }

  return {
    value: parsed,
    usedDefault: false
  };
}

export function resolveAtpRetryBudgets(
  options: ResolveAtpRetryBudgetOptions = {}
): AtpRetryBudgets {
  const env = options.env ?? process.env;
  const nodeEnv = String(env.NODE_ENV ?? 'development').trim().toLowerCase() || 'development';
  const serializableRetries = parseNonNegativeIntegerBudget(
    env,
    'ATP_SERIALIZABLE_RETRIES',
    ATP_RETRY_BUDGET_DEFAULTS.serializableRetries
  );
  const reservationCreateRetries = parseNonNegativeIntegerBudget(
    env,
    'ATP_RESERVATION_CREATE_RETRIES',
    ATP_RETRY_BUDGET_DEFAULTS.reservationCreateRetries
  );

  const budgets: AtpRetryBudgets = {
    nodeEnv,
    serializableRetries: serializableRetries.value,
    reservationCreateRetries: reservationCreateRetries.value,
    defaultsUsed: {
      serializableRetries: serializableRetries.usedDefault,
      reservationCreateRetries: reservationCreateRetries.usedDefault
    }
  };

  if (options.enforceProductionCaps && nodeEnv === 'production') {
    const exceedsCap =
      budgets.serializableRetries > ATP_RETRY_BUDGET_PROD_CAPS.serializableRetries
      || budgets.reservationCreateRetries > ATP_RETRY_BUDGET_PROD_CAPS.reservationCreateRetries;

    if (exceedsCap) {
      throw buildStructuredError('ATP_RETRY_BUDGETS_UNSAFE_FOR_PRODUCTION', {
        nodeEnv,
        serializableRetries: budgets.serializableRetries,
        reservationCreateRetries: budgets.reservationCreateRetries,
        caps: ATP_RETRY_BUDGET_PROD_CAPS
      });
    }
  }

  return budgets;
}

export function emitAtpRetryBudgetsEffectiveLogOnce(
  budgets: AtpRetryBudgets,
  logger: (message: string) => void = (message) => console.log(message)
): boolean {
  const globalState = globalThis as Record<PropertyKey, unknown>;
  if (globalState[ATP_RETRY_BUDGETS_LOG_ONCE_KEY] === true) {
    return false;
  }
  globalState[ATP_RETRY_BUDGETS_LOG_ONCE_KEY] = true;
  logger(JSON.stringify({
    code: 'ATP_RETRY_BUDGETS_EFFECTIVE',
    nodeEnv: budgets.nodeEnv,
    serializableRetries: budgets.serializableRetries,
    reservationCreateRetries: budgets.reservationCreateRetries,
    defaultsUsed: budgets.defaultsUsed
  }));
  return true;
}
