import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { ClickRecord } from '../../types';
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

export interface ClickListOptions {
  offer_id?: string;
  aff_id?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export const clickRepository = {
  // The redirect path never awaits this; see services/clickService.persistAsync.
  async insert(click: ClickRecord): Promise<void> {
    await db()
      .collection(COLLECTIONS.CLICKS)
      .doc(click.click_id)
      .set({
        ...click,
        created_at: FieldValue.serverTimestamp(),
      });
  },

  async getById(click_id: string): Promise<ClickRecord | null> {
    const snap = await db().collection(COLLECTIONS.CLICKS).doc(click_id).get();
    if (!snap.exists) return null;
    const raw = snap.data() as Record<string, unknown>;
    return {
      ...(raw as unknown as ClickRecord),
      click_id,
      created_at:
        (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString?.() ??
        (raw.created_at as string | undefined) ??
        '',
    };
  },

  // Cursor-paginated click list for reporting. Uses the composite indexes
  // declared in INDEXES (offer_id/aff_id/aff_id+offer_id paired with
  // created_at DESC). Without any filter, falls back to a plain created_at
  // scan (Firestore auto-creates the single-field index).
  async list(opts: ClickListOptions = {}): Promise<ListResult<ClickRecord>> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
    let query: FirebaseFirestore.Query = db().collection(COLLECTIONS.CLICKS);

    if (opts.offer_id) query = query.where('offer_id', '==', opts.offer_id);
    if (opts.aff_id) query = query.where('aff_id', '==', opts.aff_id);
    if (opts.from) query = query.where('created_at', '>=', opts.from);
    if (opts.to) query = query.where('created_at', '<=', opts.to);

    query = query.orderBy('created_at', 'desc');

    const cursorVal = decodeCursor(opts.cursor);
    if (cursorVal) query = query.startAfter(new Date(cursorVal));

    const snap = await query.limit(limit + 1).get();
    const docs = snap.docs.slice(0, limit);
    const hasMore = snap.docs.length > limit;

    const items: ClickRecord[] = docs.map((d) => {
      const raw = d.data() as Record<string, unknown>;
      return {
        ...(raw as unknown as ClickRecord),
        click_id: d.id,
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

  // Materialise all click documents in a time range for aggregation.
  // Bounded by `max` to protect us from over-fetching — callers should pass
  // a ceiling that's safe for memory + latency (e.g. 10k for a 90-day range).
  async fetchRange(opts: {
    from: Date;
    to: Date;
    offer_id?: string;
    aff_id?: string;
    max: number;
  }): Promise<Array<Pick<ClickRecord, 'click_id' | 'offer_id' | 'aff_id' | 'created_at' | 'country'>>> {
    let query: FirebaseFirestore.Query = db().collection(COLLECTIONS.CLICKS);
    if (opts.offer_id) query = query.where('offer_id', '==', opts.offer_id);
    if (opts.aff_id) query = query.where('aff_id', '==', opts.aff_id);
    query = query
      .where('created_at', '>=', opts.from)
      .where('created_at', '<=', opts.to)
      .orderBy('created_at', 'desc')
      .limit(opts.max);

    const snap = await query.get();
    return snap.docs.map((d) => {
      const raw = d.data() as Record<string, unknown>;
      return {
        click_id: d.id,
        offer_id: String(raw.offer_id ?? ''),
        aff_id: String(raw.aff_id ?? ''),
        country: raw.country as string | undefined,
        created_at:
          (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString?.() ??
          (raw.created_at as string | undefined) ??
          '',
      };
    });
  },

  async countRange(opts: { from: Date; to: Date; offer_id?: string; aff_id?: string }): Promise<number> {
    let query: FirebaseFirestore.Query = db().collection(COLLECTIONS.CLICKS);
    if (opts.offer_id) query = query.where('offer_id', '==', opts.offer_id);
    if (opts.aff_id) query = query.where('aff_id', '==', opts.aff_id);
    query = query
      .where('created_at', '>=', opts.from)
      .where('created_at', '<=', opts.to);
    const snap = await query.count().get();
    return snap.data().count;
  },
};
