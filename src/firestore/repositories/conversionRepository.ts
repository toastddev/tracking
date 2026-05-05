import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { ConversionRecord } from '../../types';
import type { ListResult } from './offerRepository';

function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export interface ConversionListOptions {
  network_id: string;
  verified?: boolean;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export interface ConversionListAllOptions {
  network_id?: string;
  offer_id?: string;
  // Multi-offer filter. Applied in-memory on top of the index-backed
  // (network_id, created_at) scan so we don't need a new composite index for
  // every (network, offer-set) combination. Practical cap is ~30 ids; bigger
  // sets become inefficient because we may have to over-fetch to fill a page.
  // If both `offer_id` and `offer_ids` are set, `offer_ids` wins.
  offer_ids?: string[];
  verified?: boolean;
  status?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export interface ConversionRangeOptions {
  from: Date;
  to: Date;
  network_id?: string;
  offer_id?: string;
  verified?: boolean;
}

export const conversionRepository = {
  async insert(conv: ConversionRecord): Promise<void> {
    await db()
      .collection(COLLECTIONS.CONVERSIONS)
      .doc(conv.conversion_id)
      .set({
        ...conv,
        created_at: FieldValue.serverTimestamp(),
      });
  },

  // Idempotent insert keyed off (aff_api_id + external_id). Doc id is
  // deterministic so re-runs of the same window are no-ops in Firestore.
  // Returns true on first write, false if the row already existed.
  async insertIfAbsent(conv: ConversionRecord): Promise<boolean> {
    const ref = db().collection(COLLECTIONS.CONVERSIONS).doc(conv.conversion_id);
    return db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { ...conv, created_at: FieldValue.serverTimestamp() });
      return true;
    });
  },

  // Bulk variant for hot loops. Uses a BulkWriter with create() so existing
  // docs error out and are silently dropped — deterministic-id dedupe.
  async bulkInsertIfAbsent(records: ConversionRecord[]): Promise<{ inserted: number; duplicates: number; insertedRecords: ConversionRecord[] }> {
    if (records.length === 0) return { inserted: 0, duplicates: 0, insertedRecords: [] };
    const writer = db().bulkWriter();
    let inserted = 0;
    let duplicates = 0;
    const insertedRecords: ConversionRecord[] = [];
    writer.onWriteError((err) => {
      if (err.code === 6 /* ALREADY_EXISTS */) {
        duplicates++;
        return false;
      }
      // Retry transient errors a few times before surfacing.
      return err.failedAttempts < 5;
    });
    for (const conv of records) {
      const ref = db().collection(COLLECTIONS.CONVERSIONS).doc(conv.conversion_id);
      writer.create(ref, { ...conv, created_at: FieldValue.serverTimestamp() })
        .then(() => { 
          inserted++; 
          insertedRecords.push(conv);
        })
        .catch(() => { /* surfaced via onWriteError */ });
    }
    await writer.close();
    return { inserted, duplicates, insertedRecords };
  },

  // All conversions tied to one click_id, newest first. Backed by the
  // (click_id ASC, created_at DESC) composite index declared in INDEXES.
  async listByClickId(click_id: string, limit = 25): Promise<ConversionRecord[]> {
    const snap = await db()
      .collection(COLLECTIONS.CONVERSIONS)
      .where('click_id', '==', click_id)
      .orderBy('created_at', 'desc')
      .limit(Math.min(Math.max(limit, 1), 200))
      .get();
    return snap.docs.map((d) => {
      const raw = d.data() as Record<string, unknown>;
      return {
        ...(raw as unknown as ConversionRecord),
        conversion_id: d.id,
        created_at:
          (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString?.() ??
          (raw.created_at as string | undefined) ??
          '',
      };
    });
  },

  async getById(conversion_id: string): Promise<ConversionRecord | null> {
    const snap = await db().collection(COLLECTIONS.CONVERSIONS).doc(conversion_id).get();
    if (!snap.exists) return null;
    const raw = snap.data() as Record<string, unknown>;
    return {
      ...(raw as unknown as ConversionRecord),
      conversion_id,
      // normalise Firestore Timestamp → ISO string for the API response
      created_at:
        (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString?.() ??
        (raw.created_at as string | undefined) ??
        '',
    };
  },

  // Per-network event log — relies on composite index
  // (network_id ASC, verified ASC, created_at DESC) for the filtered case
  // and (network_id ASC, created_at DESC) for the unfiltered case.
  async listByNetwork(opts: ConversionListOptions): Promise<ListResult<ConversionRecord>> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    let query: FirebaseFirestore.Query = db()
      .collection(COLLECTIONS.CONVERSIONS)
      .where('network_id', '==', opts.network_id);

    if (typeof opts.verified === 'boolean') {
      query = query.where('verified', '==', opts.verified);
    }
    if (opts.from) query = query.where('created_at', '>=', opts.from);
    if (opts.to) query = query.where('created_at', '<=', opts.to);

    query = query.orderBy('created_at', 'desc');

    const cursorVal = decodeCursor(opts.cursor);
    if (cursorVal) {
      query = query.startAfter(new Date(cursorVal));
    }

    const snap = await query.limit(limit + 1).get();
    const docs = snap.docs.slice(0, limit);
    const hasMore = snap.docs.length > limit;

    const items: ConversionRecord[] = docs.map((d) => {
      const raw = d.data() as Record<string, unknown>;
      return {
        ...(raw as unknown as ConversionRecord),
        conversion_id: d.id,
        created_at:
          (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString?.() ??
          (raw.created_at as string | undefined) ??
          '',
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && docs.length > 0) {
      const last = docs[docs.length - 1]!;
      const ts = (last.data().created_at as { toDate?: () => Date } | undefined)?.toDate?.();
      if (ts) nextCursor = encodeCursor(ts.toISOString());
    }

    return { items, nextCursor };
  },

  // Cross-network conversions list for the global reports view. Relies on the
  // composite indexes declared in INDEXES. Combining multiple equality filters
  // (network_id + verified, offer_id + verified, etc.) needs a matching index —
  // we declare the common ones; exotic combos will surface a Firestore error.
  async listAll(opts: ConversionListAllOptions = {}): Promise<ListResult<ConversionRecord>> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
    const offerSet = opts.offer_ids && opts.offer_ids.length > 0
      ? new Set(opts.offer_ids)
      : null;

    function buildBaseQuery(startAfter?: Date): FirebaseFirestore.Query {
      let q: FirebaseFirestore.Query = db().collection(COLLECTIONS.CONVERSIONS);
      if (opts.network_id) q = q.where('network_id', '==', opts.network_id);
      // When an explicit multi-set is provided, skip the single-id filter —
      // the in-memory `offerSet` check below covers it.
      if (!offerSet && opts.offer_id) q = q.where('offer_id', '==', opts.offer_id);
      if (typeof opts.verified === 'boolean') q = q.where('verified', '==', opts.verified);
      if (opts.status) q = q.where('status', '==', opts.status);
      if (opts.from) q = q.where('created_at', '>=', opts.from);
      if (opts.to) q = q.where('created_at', '<=', opts.to);
      q = q.orderBy('created_at', 'desc');
      if (startAfter) q = q.startAfter(startAfter);
      return q;
    }

    function rowFromDoc(d: FirebaseFirestore.QueryDocumentSnapshot): ConversionRecord {
      const raw = d.data() as Record<string, unknown>;
      return {
        ...(raw as unknown as ConversionRecord),
        conversion_id: d.id,
        created_at:
          (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString?.() ??
          (raw.created_at as string | undefined) ??
          '',
      };
    }

    const cursorVal = decodeCursor(opts.cursor);
    let cursorDate = cursorVal ? new Date(cursorVal) : undefined;

    // Simple path: no in-memory filter needed.
    if (!offerSet) {
      const snap = await buildBaseQuery(cursorDate).limit(limit + 1).get();
      const docs = snap.docs.slice(0, limit);
      const hasMore = snap.docs.length > limit;
      const items = docs.map(rowFromDoc);
      let nextCursor: string | null = null;
      if (hasMore && docs.length > 0) {
        const last = docs[docs.length - 1]!;
        const ts = (last.data().created_at as { toDate?: () => Date } | undefined)?.toDate?.();
        if (ts) nextCursor = encodeCursor(ts.toISOString());
      }
      return { items, nextCursor };
    }

    // Multi-offer path: page through the index-backed scan, filter in memory,
    // accumulate until we have `limit` rows or run out. The cursor returned
    // is the created_at of the last RETURNED (filter-passing) row, so paging
    // remains monotonic even with sparse pages.
    const FETCH_BATCH = Math.min(200, Math.max(limit * 5, 50));
    const SCAN_CAP = 1000; // hard cap on rows scanned per request to avoid runaway reads
    const items: ConversionRecord[] = [];
    let scanned = 0;
    let lastCursorAdvance = cursorDate;
    let underlyingExhausted = false;

    while (items.length < limit && scanned < SCAN_CAP) {
      const snap = await buildBaseQuery(lastCursorAdvance).limit(FETCH_BATCH).get();
      if (snap.empty) {
        underlyingExhausted = true;
        break;
      }
      scanned += snap.size;
      for (const d of snap.docs) {
        const row = rowFromDoc(d);
        if (offerSet.has(row.offer_id ?? '')) {
          items.push(row);
          if (items.length >= limit) break;
        }
      }
      // Advance cursor past the last scanned row regardless of whether it
      // matched, so the next inner page picks up after it.
      const lastScannedTs = (snap.docs[snap.docs.length - 1]!.data().created_at as { toDate?: () => Date } | undefined)?.toDate?.();
      if (!lastScannedTs) {
        underlyingExhausted = true;
        break;
      }
      lastCursorAdvance = lastScannedTs;
      if (snap.size < FETCH_BATCH) {
        underlyingExhausted = true;
        break;
      }
    }

    let nextCursor: string | null = null;
    if (items.length >= limit && !underlyingExhausted) {
      // Cursor for next page: the created_at of the last returned row, not
      // the last scanned row, so paging is stable across `offer_ids` changes.
      const lastReturnedTs = items[items.length - 1]!.created_at;
      if (lastReturnedTs) nextCursor = encodeCursor(lastReturnedTs);
    }

    return { items, nextCursor };
  },

  // Materialise a time range of conversions for bucketing/aggregation.
  async fetchRange(opts: ConversionRangeOptions & { max: number }): Promise<
    Array<Pick<ConversionRecord, 'conversion_id' | 'network_id' | 'offer_id' | 'click_id' | 'payout' | 'currency' | 'verified' | 'status' | 'created_at'> & { shadow?: boolean }>
  > {
    let query: FirebaseFirestore.Query = db().collection(COLLECTIONS.CONVERSIONS);
    if (opts.network_id) query = query.where('network_id', '==', opts.network_id);
    if (opts.offer_id) query = query.where('offer_id', '==', opts.offer_id);
    if (typeof opts.verified === 'boolean') query = query.where('verified', '==', opts.verified);
    query = query
      .where('created_at', '>=', opts.from)
      .where('created_at', '<=', opts.to)
      .orderBy('created_at', 'desc')
      .limit(opts.max);

    const snap = await query.get();
    return snap.docs.map((d) => {
      const raw = d.data() as Record<string, unknown>;
      return {
        conversion_id: d.id,
        network_id: String(raw.network_id ?? ''),
        offer_id: raw.offer_id as string | undefined,
        click_id: String(raw.click_id ?? ''),
        payout: typeof raw.payout === 'number' ? raw.payout : undefined,
        currency: raw.currency as string | undefined,
        verified: Boolean(raw.verified),
        status: raw.status as string | undefined,
        shadow: Boolean(raw.shadow),
        created_at:
          (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString?.() ??
          (raw.created_at as string | undefined) ??
          '',
      };
    });
  },

  async countRange(opts: ConversionRangeOptions): Promise<number> {
    let query: FirebaseFirestore.Query = db().collection(COLLECTIONS.CONVERSIONS);
    if (opts.network_id) query = query.where('network_id', '==', opts.network_id);
    if (opts.offer_id) query = query.where('offer_id', '==', opts.offer_id);
    if (typeof opts.verified === 'boolean') query = query.where('verified', '==', opts.verified);
    query = query
      .where('created_at', '>=', opts.from)
      .where('created_at', '<=', opts.to);
    const snap = await query.count().get();
    return snap.data().count;
  },

  async sumPayout(opts: ConversionRangeOptions): Promise<number> {
    let query: FirebaseFirestore.Query = db().collection(COLLECTIONS.CONVERSIONS);
    if (opts.network_id) query = query.where('network_id', '==', opts.network_id);
    if (opts.offer_id) query = query.where('offer_id', '==', opts.offer_id);
    if (typeof opts.verified === 'boolean') query = query.where('verified', '==', opts.verified);
    query = query
      .where('created_at', '>=', opts.from)
      .where('created_at', '<=', opts.to);
    // sum() skips null/non-numeric values and returns 0 for empty result sets.
    const { AggregateField } = await import('firebase-admin/firestore');
    const snap = await query.aggregate({ total: AggregateField.sum('payout') }).get();
    const total = snap.data().total as number | null;
    return typeof total === 'number' ? total : 0;
  },
};
