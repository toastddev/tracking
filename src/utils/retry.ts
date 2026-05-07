// Retry a Promise-returning function with exponential backoff. Used by hot
// paths that *must* persist (rollup increments, drilldowns) where the original
// fire-and-forget pattern silently lost writes during transient Firestore
// errors. Fail-fast on programmer mistakes (TypeError, RangeError); only retry
// on the kinds of error we know are transient.
//
// Defaults are sized for Firestore writes: 3 attempts, 100/200/400ms delays —
// total worst-case latency added is ~700ms before surfacing the failure.
export interface RetryOptions {
  attempts?: number;     // total attempts incl. the first; min 1
  baseDelayMs?: number;  // first backoff (ms)
  maxDelayMs?: number;   // ceiling for backoff (ms)
  onAttemptError?: (err: unknown, attempt: number) => void;
}

const TRANSIENT_GRPC_CODES = new Set([
  4,   // DEADLINE_EXCEEDED
  8,   // RESOURCE_EXHAUSTED (rate-limit / quota)
  10,  // ABORTED (contention)
  13,  // INTERNAL
  14,  // UNAVAILABLE (network blip)
  15,  // DATA_LOSS — rare, retry once is harmless
]);

function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number' && TRANSIENT_GRPC_CODES.has(code)) return true;
  // Some Firestore errors come back with string codes like 'unavailable'.
  if (typeof code === 'string') {
    const c = code.toLowerCase();
    if (c.includes('unavailable') || c.includes('aborted') || c.includes('deadline') || c.includes('exhausted') || c.includes('internal')) return true;
  }
  // Programmer errors → never retry.
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError || err instanceof SyntaxError) return false;
  // Default: assume transient. Worst case is ~700ms extra latency.
  return true;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = Math.max(0, opts.baseDelayMs ?? 100);
  const cap = Math.max(base, opts.maxDelayMs ?? 800);

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      opts.onAttemptError?.(err, i + 1);
      if (i >= attempts - 1) break;
      if (!isTransient(err)) break;
      const delay = Math.min(cap, base * Math.pow(2, i));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
