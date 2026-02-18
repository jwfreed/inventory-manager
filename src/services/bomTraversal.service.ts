import { toNumber } from '../lib/numbers';
import type { BomVersion } from './boms.service';

const DEFAULT_MAX_BOM_EXPANSION_DEPTH = 20;
const DEFAULT_PATH_DETAIL_LIMIT = 50;

type BomTraversalErrorCode = 'BOM_CYCLE_DETECTED' | 'BOM_MAX_DEPTH_EXCEEDED';

type BomTraversalError = Error & {
  code: BomTraversalErrorCode;
  details: {
    maxDepth: number;
    currentDepth: number;
    path: string[];
    pathSample: string[];
    pathTruncated: boolean;
    maxDepthSource: 'default' | 'env';
  };
};

type TraversalComponent = {
  id: string;
  componentItemId: string;
};

type PhantomExpansionNode<TState, TComponent extends TraversalComponent> = {
  itemId: string;
  components: TComponent[];
  state: TState;
};

type ExpandBomWithCycleGuardInput<TState, TComponent extends TraversalComponent> = {
  root: PhantomExpansionNode<TState, TComponent>;
  onComponent: (args: {
    node: PhantomExpansionNode<TState, TComponent>;
    component: TComponent;
    path: string[];
    depth: number;
    descend: (next: PhantomExpansionNode<TState, TComponent>) => Promise<void>;
  }) => Promise<void>;
  maxDepth?: number;
};

function getMaxDepth() {
  const raw = process.env.BOM_EXPANSION_MAX_DEPTH;
  if (raw === undefined || raw === null || raw === '') {
    return { value: DEFAULT_MAX_BOM_EXPANSION_DEPTH, source: 'default' as const };
  }
  const configured = Number(raw);
  if (!Number.isFinite(configured) || configured <= 0) {
    return { value: DEFAULT_MAX_BOM_EXPANSION_DEPTH, source: 'default' as const };
  }
  return { value: Math.floor(configured), source: 'env' as const };
}

function buildPathDetails(path: string[]) {
  if (path.length <= DEFAULT_PATH_DETAIL_LIMIT) {
    return {
      path: [...path],
      pathSample: [...path],
      pathTruncated: false
    };
  }
  const headSize = Math.ceil(DEFAULT_PATH_DETAIL_LIMIT / 2);
  const tailSize = DEFAULT_PATH_DETAIL_LIMIT - headSize;
  return {
    path: [...path.slice(0, DEFAULT_PATH_DETAIL_LIMIT)],
    pathSample: [...path.slice(0, headSize), ...path.slice(-tailSize)],
    pathTruncated: true
  };
}

function bomTraversalError(
  code: BomTraversalErrorCode,
  path: string[],
  maxDepth: number,
  depth: number,
  maxDepthSource: 'default' | 'env'
): BomTraversalError {
  const error = new Error(code) as BomTraversalError;
  const pathDetails = buildPathDetails(path);
  error.code = code;
  error.details = {
    maxDepth,
    currentDepth: depth,
    path: pathDetails.path,
    pathSample: pathDetails.pathSample,
    pathTruncated: pathDetails.pathTruncated,
    maxDepthSource
  };
  return error;
}

function sortComponentsDeterministically<TComponent extends TraversalComponent>(components: TComponent[]) {
  return [...components].sort((left, right) => {
    const itemCompare = left.componentItemId.localeCompare(right.componentItemId);
    if (itemCompare !== 0) return itemCompare;
    return left.id.localeCompare(right.id);
  });
}

export async function expandBomWithCycleGuard<TState, TComponent extends TraversalComponent>(
  input: ExpandBomWithCycleGuardInput<TState, TComponent>
): Promise<void> {
  const resolvedMaxDepth = input.maxDepth !== undefined
    ? { value: input.maxDepth, source: 'env' as const }
    : getMaxDepth();
  const maxDepth = resolvedMaxDepth.value;
  const path: string[] = [input.root.itemId];
  const inPath = new Set<string>(path);
  // Intentionally no global "visited skip" set: DAG reuse must expand on every branch.

  const walk = async (node: PhantomExpansionNode<TState, TComponent>, depth: number) => {
    if (depth > maxDepth) {
      throw bomTraversalError(
        'BOM_MAX_DEPTH_EXCEEDED',
        [...path],
        maxDepth,
        path.length,
        resolvedMaxDepth.source
      );
    }

    const sorted = sortComponentsDeterministically(node.components);
    for (const component of sorted) {
      await input.onComponent({
        node,
        component,
        path: [...path],
        depth,
        descend: async (next) => {
          const nextDepth = depth + 1;
          if (nextDepth > maxDepth) {
            throw bomTraversalError(
              'BOM_MAX_DEPTH_EXCEEDED',
              [...path, next.itemId],
              maxDepth,
              nextDepth + 1,
              resolvedMaxDepth.source
            );
          }
          if (inPath.has(next.itemId)) {
            const startIndex = path.indexOf(next.itemId);
            const cyclePath = [...path.slice(startIndex), next.itemId];
            throw bomTraversalError(
              'BOM_CYCLE_DETECTED',
              cyclePath,
              maxDepth,
              cyclePath.length,
              resolvedMaxDepth.source
            );
          }
          path.push(next.itemId);
          inPath.add(next.itemId);
          try {
            await walk(next, nextDepth);
          } finally {
            path.pop();
            inPath.delete(next.itemId);
          }
        }
      });
    }
  };

  await walk(input.root, 0);
}

export async function getCanonicalYieldQuantity(
  tenantId: string,
  bomVersion: Pick<BomVersion, 'yieldQuantity' | 'yieldUom' | 'yieldFactor'>,
  convertToCanonical: (tenantId: string, itemId: string, quantity: number, uom: string) => Promise<{
    quantity: number;
  }>,
  itemId: string
) {
  const canonicalYield = await convertToCanonical(
    tenantId,
    itemId,
    toNumber(bomVersion.yieldQuantity),
    bomVersion.yieldUom
  );
  const yieldFactor = bomVersion.yieldFactor ?? 1;
  if (canonicalYield.quantity <= 0 || yieldFactor <= 0) {
    throw new Error('WO_REQUIREMENTS_INVALID_YIELD');
  }
  return canonicalYield.quantity * yieldFactor;
}
