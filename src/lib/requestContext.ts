import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContext = {
  requestId?: string;
  tenantId?: string | null;
  userId?: string | null;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function updateRequestContext(patch: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, patch);
}
