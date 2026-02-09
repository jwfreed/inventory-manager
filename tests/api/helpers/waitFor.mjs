const activeTimers = new Set();

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      activeTimers.delete(timer);
      resolve();
    }, ms);
    activeTimers.add(timer);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        activeTimers.delete(timer);
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason ?? new Error('Aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function clearWaitForTimers() {
  for (const timer of activeTimers) {
    clearTimeout(timer);
  }
  activeTimers.clear();
}

export async function waitForCondition(
  fn,
  predicate,
  { timeoutMs = 60000, intervalMs = 100, label = 'condition', signal } = {}
) {
  const start = Date.now();
  let lastValue;
  let lastError;
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Aborted');
    }
    try {
      lastValue = await fn();
      if (predicate(lastValue)) return lastValue;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs, signal);
  }
  const elapsed = Date.now() - start;
  const details = typeof lastValue === 'string' ? lastValue : JSON.stringify(lastValue);
  const errorMsg = lastError ? String(lastError?.message ?? lastError) : 'none';
  throw new Error(
    `[waitFor:${label}] Timeout after ${elapsed}ms, lastValue=${details}, lastError=${errorMsg}`
  );
}

export async function waitForValue(fn, expected, options = {}) {
  return waitForCondition(
    fn,
    (value) => value === expected,
    { label: `value=${expected}`, ...options }
  );
}
