type CircuitState = 'closed' | 'open' | 'half-open';

export type CircuitBreakerOptions = {
  failureThreshold: number;
  resetTimeoutMs: number;
};

export class CircuitBreaker {
  private failures = 0;
  private state: CircuitState = 'closed';
  private openedAt = 0;

  constructor(private options: CircuitBreakerOptions) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.options.resetTimeoutMs) {
        throw new Error('CIRCUIT_OPEN');
      }
      this.state = 'half-open';
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure() {
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}

export type BulkheadOptions = {
  maxConcurrent: number;
};

export class Bulkhead {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private options: BulkheadOptions) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.options.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    return () => {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

export type RetryOptions = {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
};

export type ResilientFetchOptions = {
  timeoutMs: number;
  retry: RetryOptions;
  circuitBreaker?: CircuitBreaker;
  bulkhead?: Bulkhead;
};

const DEFAULT_RETRY: RetryOptions = {
  retries: 2,
  baseDelayMs: 200,
  maxDelayMs: 2000,
  jitterMs: 100
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(attempt: number, retry: RetryOptions) {
  const exponential = Math.min(retry.baseDelayMs * 2 ** attempt, retry.maxDelayMs);
  const jitter = Math.random() * retry.jitterMs;
  return exponential + jitter;
}

function isRetryableStatus(status: number) {
  return status >= 500 || status === 429;
}

export async function resilientFetch(
  url: string,
  init: RequestInit,
  options: Partial<ResilientFetchOptions> = {}
): Promise<Response> {
  const retry = options.retry ?? DEFAULT_RETRY;
  const timeoutMs = options.timeoutMs ?? 5000;
  const breaker = options.circuitBreaker;
  const bulkhead = options.bulkhead;

  const attemptRequest = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const execute = async () => {
    if (breaker) {
      return breaker.execute(attemptRequest);
    }
    return attemptRequest();
  };

  for (let attempt = 0; attempt <= retry.retries; attempt += 1) {
    let release: (() => void) | null = null;
    try {
      if (bulkhead) {
        release = await bulkhead.acquire();
      }
      const response = await execute();
      if (isRetryableStatus(response.status) && attempt < retry.retries) {
        const delay = computeDelay(attempt, retry);
        await sleep(delay);
        continue;
      }
      return response;
    } catch (err) {
      if (attempt >= retry.retries) {
        throw err;
      }
      const delay = computeDelay(attempt, retry);
      await sleep(delay);
    } finally {
      if (release) release();
    }
  }

  throw new Error('RESILIENT_FETCH_FAILED');
}
