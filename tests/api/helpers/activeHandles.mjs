function isStdio(handle) {
  return handle === process.stdout || handle === process.stderr || handle === process.stdin;
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
