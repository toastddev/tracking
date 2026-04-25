import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { Offer } from '../../types';

const TTL_MS = 60_000;
const cache = new Map<string, { offer: Offer; expires: number }>();

export interface ListOptions {
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface ListResult<T> {
  items: T[];
  nextCursor: string | null;
}

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

export const offerRepository = {
  async getById(offer_id: string): Promise<Offer | null> {
    const now = Date.now();
    const hit = cache.get(offer_id);
    if (hit && hit.expires > now) return hit.offer;

    const snap = await db().collection(COLLECTIONS.OFFERS).doc(offer_id).get();
    if (!snap.exists) {
      cache.delete(offer_id);
      return null;
    }
    const offer = { offer_id, ...(snap.data() as Omit<Offer, 'offer_id'>) };
    cache.set(offer_id, { offer, expires: now + TTL_MS });
    return offer;
  },

  // Cursor-paginated list, default newest-first by created_at. Search is a
  // case-insensitive prefix match on `name_lower` so it benefits from a
  // single-field index that Firestore auto-creates.
  async list(opts: ListOptions = {}): Promise<ListResult<Offer>> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const col = db().collection(COLLECTIONS.OFFERS);
    let query: FirebaseFirestore.Query = col;

    if (opts.q) {
      const q = opts.q.toLowerCase();
      query = query
        .where('name_lower', '>=', q)
        .where('name_lower', '<=', q + String.fromCharCode(0xf8ff))
        .orderBy('name_lower');
    } else {
      query = query.orderBy('created_at', 'desc');
    }

    const cursorVal = decodeCursor(opts.cursor);
    if (cursorVal) query = query.startAfter(cursorVal);

    const snap = await query.limit(limit + 1).get();
    const docs = snap.docs.slice(0, limit);
    const hasMore = snap.docs.length > limit;

    const items: Offer[] = docs.map((d) => ({
      offer_id: d.id,
      ...(d.data() as Omit<Offer, 'offer_id'>),
    }));

    let nextCursor: string | null = null;
    if (hasMore && docs.length > 0) {
      const last = docs[docs.length - 1]!;
      const data = last.data();
      const cursorRaw = opts.q ? String(data.name_lower ?? '') : String(data.created_at?.toDate?.()?.toISOString?.() ?? '');
      nextCursor = encodeCursor(cursorRaw);
    }

    return { items, nextCursor };
  },

  async create(offer_id: string, data: Omit<Offer, 'offer_id' | 'created_at' | 'updated_at'>): Promise<Offer> {
    const ref = db().collection(COLLECTIONS.OFFERS).doc(offer_id);
    const exists = (await ref.get()).exists;
    if (exists) throw new Error('offer_already_exists');

    const payload = {
      ...data,
      name_lower: data.name?.toLowerCase() ?? '',
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    };
    await ref.set(payload);
    cache.delete(offer_id);
    const snap = await ref.get();
    return { offer_id, ...(snap.data() as Omit<Offer, 'offer_id'>) };
  },

  async update(offer_id: string, patch: Partial<Omit<Offer, 'offer_id' | 'created_at'>>): Promise<Offer | null> {
    const ref = db().collection(COLLECTIONS.OFFERS).doc(offer_id);
    const exists = (await ref.get()).exists;
    if (!exists) return null;

    const update: Record<string, unknown> = { ...patch, updated_at: FieldValue.serverTimestamp() };
    if (patch.name) update.name_lower = patch.name.toLowerCase();
    await ref.update(update);
    cache.delete(offer_id);
    const snap = await ref.get();
    return { offer_id, ...(snap.data() as Omit<Offer, 'offer_id'>) };
  },

  async delete(offer_id: string): Promise<boolean> {
    const ref = db().collection(COLLECTIONS.OFFERS).doc(offer_id);
    const exists = (await ref.get()).exists;
    if (!exists) return false;
    await ref.delete();
    cache.delete(offer_id);
    return true;
  },

  invalidate(offer_id?: string): void {
    if (offer_id) cache.delete(offer_id);
    else cache.clear();
  },
};
