// Reconciler handler interface — every platform (offer_reports, GAds campaign
// reports, FB campaign reports, future TikTok, …) implements this.
//
// The unified reconciler scans `clicks` and `conversions` ONCE per tick and
// dispatches each raw doc to every active handler. Each handler owns its own
// bucket map, its own collection write target, and its own extraction logic.
// Adding a new platform = add one handler; no change to the main scanner.
//
// Cost win: before this, every backfill independently scanned the full window
// of clicks + conversions. With N handlers in the old design, you paid N×
// Firestore reads. With this design, you pay 1× regardless of how many
// platforms you reconcile.

// Lifecycle:
//   1. prepare(window)   — read your existing rollup, build initial bucket map.
//                           Return participates=false to skip (e.g. truncated).
//   2. processClick(...)  — called for every click in the scan window. Handler
//                           decides if it cares (e.g. is this click GAds-tagged?
//                           FB-tagged?). Cache click metadata as needed.
//   3. processConversion(...) — called for every (non-shadow) conversion.
//                           Handler attributes via its own clickMeta cache.
//   4. needsOrphanLookup(click_id): bool — for conversions whose click wasn't
//                           in pass 2's window, the main scanner does ONE
//                           batched fetch of the union of click_ids any
//                           handler cares about. Handler answers per-id.
//   5. processOrphanClick(...) — main scanner delivers fetched orphan clicks.
//   6. flush() — write buckets to your own collection. Returns counters for
//                the run record.
//
// Every method is wrapped in try/catch by the main scanner: a bug in handler
// A doesn't abort handler B. The handler's own `ok` flag flips false on
// catastrophic failure so flush() is skipped for that handler.

export interface ReconcilerWindow {
  from: Date;              // start-of-UTC-day, normalized
  to: Date;                // end-of-UTC-day, normalized
  fromDay: string;         // 'YYYY-MM-DD'
  toDay: string;
  // Wider scan range for the conversions pass — picks up rows whose
  // network_timestamp falls inside [from, to] but whose created_at spilled
  // outside (late affiliate-API pulls).
  scanFrom: Date;
  scanTo: Date;
}

export interface PrepareResult {
  participates: boolean;
  // Buckets already in the handler's collection for this window. Surfaced so
  // the main scanner's run record can show pre-existing state per platform.
  existing_buckets_scanned?: number;
  truncated?: boolean;
  truncated_reason?: string;
}

export interface FlushResult {
  name: string;             // handler name (for run record + logs)
  ok: boolean;
  buckets_written: number;
  // Per-handler counters surfaced in the unified result. Optional because
  // not every handler reports them (offer_reports doesn't scan clicks).
  clicks_with_campaign?: number;
  conversions_scanned?: number;
  conversions_with_campaign?: number;
  conversions_orphan_lookups?: number;
  revenue_fx_skipped?: number;
  existing_buckets_scanned?: number;
  truncated?: boolean;
  truncated_reason?: string;
  error?: string;
  duration_ms?: number;
}

export interface ReconcilerHandler {
  readonly name: string;
  // If false, the main scanner skips the clicks pass for this handler — saves
  // CPU calls when no handler in the run needs them (offer_reports only).
  readonly needsClickScan: boolean;

  prepare(window: ReconcilerWindow): Promise<PrepareResult>;

  // Pass 2 — every click in [from, to]. Handler decides if it matters.
  // Synchronous: pure CPU work on the loaded doc. Don't do I/O here.
  processClick(click_id: string, rawClick: Record<string, unknown>): void;

  // Pass 3 — every non-shadow conversion in the widened scan window.
  // Handler attributes via internal clickMeta cache; for unmatched click_ids,
  // it returns true from needsOrphanLookup() so main batches a fetch.
  processConversion(conversion_id: string, rawConv: Record<string, unknown>): void;

  // Does this handler still want to know about this click_id? Main unions all
  // handlers' needs and fetches once.
  needsOrphanLookup(click_id: string): boolean;

  // Resolution of an orphan click. Sync, pure CPU.
  processOrphanClick(click_id: string, rawClick: Record<string, unknown>): void;

  // Write buckets to handler's own collection. Runs in Promise.all with other
  // handlers — different collections, no contention.
  flush(): Promise<FlushResult>;
}

// Shared utilities used by every handler — kept here so they all agree on day
// boundaries / timestamp parsing.

export function dayKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 1);
}

export function tsToDate(v: unknown): Date | null {
  if (v && typeof v === 'object' && 'toDate' in (v as object)) {
    try { return (v as { toDate: () => Date }).toDate(); } catch { return null; }
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export type StatusBucket = 'approved' | 'pending' | 'rejected';

export function statusBucket(status: string | undefined): StatusBucket {
  const s = (status ?? '').toLowerCase();
  if (s === 'pending') return 'pending';
  if (s === 'rejected' || s === 'declined' || s === 'reversed') return 'rejected';
  return 'approved';
}
