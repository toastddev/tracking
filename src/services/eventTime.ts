// Picks the timestamp that should drive daily bucketing for a conversion.
//
// Why this exists: when a network reports a conversion via the affiliate API
// (which we pull on a schedule, often hours or even a day late), `created_at`
// records when WE ingested the row, not when the conversion actually happened
// on the network's side. Bucketing by `created_at` smears late-arriving data
// across the wrong days — a conversion the network reports at May 1 23:30 UTC
// but our 4×/day pull picks up at May 2 06:00 UTC ends up in May 2's bucket.
//
// The fix: prefer `network_timestamp` when the network sent it, fall back to
// `created_at` otherwise. S2S postbacks already arrive in real-time, so for
// them the two values differ by seconds and the choice is harmless.
//
// We DO sanity-check `network_timestamp` so a single garbage value can't
// scribble into a 1970 or 2099 bucket and silently corrupt rollups. The window
// is generous (60 days back, 6 hours forward of `created_at`) — wide enough
// to absorb honest network backfills and clock skew, narrow enough to reject
// nonsense.

const MAX_BACKDATE_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 6 * 60 * 60 * 1000;

export interface ConversionTimestamps {
  created_at: string;
  network_timestamp?: string;
}

export function eventDate(conv: ConversionTimestamps): Date {
  const created = new Date(conv.created_at);
  if (!conv.network_timestamp) return created;
  const reported = new Date(conv.network_timestamp);
  if (Number.isNaN(reported.getTime())) return created;
  if (Number.isNaN(created.getTime())) return reported;
  const delta = reported.getTime() - created.getTime();
  if (delta < -MAX_BACKDATE_MS || delta > MAX_FUTURE_MS) return created;
  return reported;
}

// Variant for backfill loops that read raw Firestore docs. Same rules, but
// accepts a pre-parsed `created_at` Date so the caller doesn't have to parse
// it twice.
export function eventDateFromRaw(
  createdAt: Date,
  networkTimestamp: unknown,
): Date {
  if (typeof networkTimestamp !== 'string' || !networkTimestamp) return createdAt;
  const reported = new Date(networkTimestamp);
  if (Number.isNaN(reported.getTime())) return createdAt;
  const delta = reported.getTime() - createdAt.getTime();
  if (delta < -MAX_BACKDATE_MS || delta > MAX_FUTURE_MS) return createdAt;
  return reported;
}

// Backfill scans pull docs by `created_at`. To capture rows whose event-day
// falls inside [from, to] but whose receipt-day spills outside, widen the
// scan by this much on each side. Sized for the typical late-pull case
// (affiliate API running every few hours, occasional same-day redeliveries),
// not the worst-case 60-day backdate window the helper tolerates. If a
// network reports a 60-day-old conversion, that bucket will only get
// rebuilt when a backfill window happens to include the receipt day.
export const BACKFILL_SCAN_PAD_BEFORE_MS = 1 * 24 * 60 * 60 * 1000;
export const BACKFILL_SCAN_PAD_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
