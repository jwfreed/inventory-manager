function compareStrings(left, right) {
  return left.localeCompare(right);
}

function canonicalizeCyclePath(path) {
  if (!Array.isArray(path) || path.length < 2) return null;
  const body = path.slice(0, -1);
  if (body.length === 0) return null;

  let best = null;
  for (let index = 0; index < body.length; index += 1) {
    const rotated = [...body.slice(index), ...body.slice(0, index)];
    const candidate = [...rotated, rotated[0]];
    const candidateKey = candidate.join('>');
    if (!best || candidateKey < best.key) {
      best = { key: candidateKey, path: candidate };
    }
  }
  return best;
}

export function detectBomCyclesAtRest(edges, { cycleLimit = 200, nodeLimit = 10000 } = {}) {
  const normalizedEdges = edges
    .filter((edge) => edge?.parent_item_id && edge?.component_item_id)
    .map((edge) => ({
      parentItemId: String(edge.parent_item_id),
      componentItemId: String(edge.component_item_id)
    }))
    .sort((left, right) => {
      const parent = compareStrings(left.parentItemId, right.parentItemId);
      if (parent !== 0) return parent;
      return compareStrings(left.componentItemId, right.componentItemId);
    });

  const adjacency = new Map();
  for (const edge of normalizedEdges) {
    const next = adjacency.get(edge.parentItemId) ?? [];
    if (!next.includes(edge.componentItemId)) {
      next.push(edge.componentItemId);
      next.sort(compareStrings);
    }
    adjacency.set(edge.parentItemId, next);
    if (!adjacency.has(edge.componentItemId)) {
      adjacency.set(edge.componentItemId, []);
    }
  }

  const nodes = Array.from(adjacency.keys()).sort(compareStrings);
  const state = new Map();
  const stack = [];
  const stackSet = new Set();
  const seenCycleKeys = new Set();
  const samplePaths = [];
  let visitedNodes = 0;
  let truncatedByNodeLimit = false;
  let truncatedByCycleLimit = false;

  const visit = (nodeId) => {
    if (samplePaths.length >= cycleLimit) return;
    if (visitedNodes >= nodeLimit) {
      truncatedByNodeLimit = true;
      return;
    }
    visitedNodes += 1;
    state.set(nodeId, 1);
    stack.push(nodeId);
    stackSet.add(nodeId);

    const neighbors = adjacency.get(nodeId) ?? [];
    for (const nextId of neighbors) {
      if (samplePaths.length >= cycleLimit || truncatedByNodeLimit) break;
      if (stackSet.has(nextId)) {
        const startIndex = stack.indexOf(nextId);
        if (startIndex >= 0) {
          const rawPath = [...stack.slice(startIndex), nextId];
          const canonical = canonicalizeCyclePath(rawPath);
          if (canonical && !seenCycleKeys.has(canonical.key)) {
            if (samplePaths.length >= cycleLimit) {
              truncatedByCycleLimit = true;
            } else {
              seenCycleKeys.add(canonical.key);
              samplePaths.push(canonical.path);
            }
          }
        }
        continue;
      }
      if ((state.get(nextId) ?? 0) === 2) continue;
      visit(nextId);
    }

    stack.pop();
    stackSet.delete(nodeId);
    state.set(nodeId, 2);
  };

  for (const nodeId of nodes) {
    if (samplePaths.length >= cycleLimit || truncatedByNodeLimit) break;
    if ((state.get(nodeId) ?? 0) !== 0) continue;
    visit(nodeId);
  }

  return {
    count: samplePaths.length,
    samplePaths,
    visitedNodes,
    truncatedByNodeLimit,
    truncatedByCycleLimit
  };
}
