export function createIdempotencyKey(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}:${crypto.randomUUID()}`
  }
  return `${prefix}:${Date.now()}`
}

export function buildIdempotencyHeaders(idempotencyKey: string) {
  return {
    'Idempotency-Key': idempotencyKey,
  }
}
