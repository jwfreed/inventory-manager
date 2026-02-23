/**
 * Helper: active handle diagnostics
 * Purpose: Snapshot active handles/requests to diagnose event-loop leaks in tests.
 * Preconditions: TEST_DEBUG_HANDLES=1 enables logging in tests/setup.mjs.
 * Postconditions: Returns normalized handle info for diffing; no side effects.
 * Consumers: test harness only.
 * Common failures: None; output may be noisy if stdio handles are included.
 */
function isStdio(handle) {
  return handle === process.stdout || handle === process.stderr || handle === process.stdin;
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function describeHandle(handle) {
  const name = handle?.constructor?.name ?? typeof handle;
  let details = '';
  try {
    if (name === 'Socket') {
      details = JSON.stringify({
        local: `${handle.localAddress ?? ''}:${handle.localPort ?? ''}`,
        remote: `${handle.remoteAddress ?? ''}:${handle.remotePort ?? ''}`,
        destroyed: handle.destroyed
      });
    } else if (name === 'ChildProcess') {
      details = JSON.stringify({
        pid: handle.pid ?? null,
        killed: handle.killed ?? null,
        exitCode: handle.exitCode ?? null,
        signalCode: handle.signalCode ?? null,
        spawnfile: handle.spawnfile ?? null,
        spawnargs: Array.isArray(handle.spawnargs) ? handle.spawnargs.slice(0, 6) : null
      });
    } else if (name === 'Timeout') {
      details = JSON.stringify({ timeout: handle._idleTimeout });
    } else if (name === 'Server') {
      const addr = typeof handle.address === 'function' ? handle.address() : undefined;
      details = JSON.stringify(addr ?? {});
    }
  } catch {
    details = '';
  }
  return { name, details };
}

function describeRequest(req) {
  const name = req?.constructor?.name ?? typeof req;
  let details = '';
  try {
    if (req?.method || req?.path) {
      details = JSON.stringify({ method: req.method, path: req.path });
    }
  } catch {
    details = '';
  }
  return { name, details };
}

export function snapshotActiveHandles() {
  const handles = process._getActiveHandles()
    .filter((handle) => !isStdio(handle))
    .map(describeHandle);
  const requests = process._getActiveRequests().map(describeRequest);
  return { handles, requests };
}

export function snapshotActiveResourcesInfo() {
  if (typeof process.getActiveResourcesInfo !== 'function') {
    return [];
  }
  try {
    return process
      .getActiveResourcesInfo()
      .map((entry) => normalizeText(entry))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

export function logActiveResources(label = '[handles]') {
  if (process.env.TEST_DEBUG_HANDLES !== '1') return;
  const snapshot = snapshotActiveHandles();
  const resources = snapshotActiveResourcesInfo();
  console.error(`${label} active handles:`, snapshot.handles);
  if (snapshot.requests.length > 0) {
    console.error(`${label} active requests:`, snapshot.requests);
  }
  if (resources.length > 0) {
    console.error(`${label} active resources:`, resources);
  }
}

function keyFor(item) {
  return `${item.name}:${item.details ?? ''}`;
}

export function diffHandleSnapshots(before, after) {
  const beforeMap = new Map();
  const afterMap = new Map();
  for (const item of before.handles) {
    const key = keyFor(item);
    beforeMap.set(key, (beforeMap.get(key) ?? 0) + 1);
  }
  for (const item of after.handles) {
    const key = keyFor(item);
    afterMap.set(key, (afterMap.get(key) ?? 0) + 1);
  }

  const added = [];
  const removed = [];
  for (const [key, count] of afterMap.entries()) {
    const beforeCount = beforeMap.get(key) ?? 0;
    if (count > beforeCount) {
      const [name, details] = key.split(':');
      added.push({ name, details, count: count - beforeCount });
    }
  }
  for (const [key, count] of beforeMap.entries()) {
    const afterCount = afterMap.get(key) ?? 0;
    if (count > afterCount) {
      const [name, details] = key.split(':');
      removed.push({ name, details, count: count - afterCount });
    }
  }

  const countsByName = (items) =>
    items.reduce((acc, item) => {
      acc[item.name] = (acc[item.name] ?? 0) + item.count;
      return acc;
    }, {});

  return { added, removed, addedCounts: countsByName(added), removedCounts: countsByName(removed) };
}
