import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { Network } from '../../types';
import type { ListOptions, ListResult } from './offerRepository';

const TTL_MS = 60_000;
const cache = new Map<string, { network: Network; expires: number }>();

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

export const networkRepository = {
  async getById(network_id: string): Promise<Network | null> {
    const now = Date.now();
    const hit = cache.get(network_id);
    if (hit && hit.expires > now) return hit.network;

    const snap = await db().collection(COLLECTIONS.NETWORKS).doc(network_id).get();
    if (!snap.exists) {
      cache.delete(network_id);
      return null;
    }
    const network = { network_id, ...(snap.data() as Omit<Network, 'network_id'>) };
    cache.set(network_id, { network, expires: now + TTL_MS });
    return network;
  },

  async list(opts: ListOptions = {}): Promise<ListResult<Network>> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const col = db().collection(COLLECTIONS.NETWORKS);
    let query: FirebaseFirestore.Query = col;

    if (opts.q) {
      const q = opts.q.toLowerCase();
      const high = q + String.fromCharCode(0xf8ff);
      query = query
        .where('name_lower', '>=', q)
        .where('name_lower', '<=', high)
        .orderBy('name_lower');
    } else {
      query = query.orderBy('created_at', 'desc');
    }

    const cursorVal = decodeCursor(opts.cursor);
    if (cursorVal) query = query.startAfter(cursorVal);

    const snap = await query.limit(limit + 1).get();
    const docs = snap.docs.slice(0, limit);
    const hasMore = snap.docs.length > limit;

    const items: Network[] = docs.map((d) => ({
      network_id: d.id,
      ...(d.data() as Omit<Network, 'network_id'>),
    }));

    let nextCursor: string | null = null;
    if (hasMore && docs.length > 0) {
      const last = docs[docs.length - 1]!;
      const data = last.data();
      const cursorRaw = opts.q
        ? String(data.name_lower ?? '')
        : String(data.created_at?.toDate?.()?.toISOString?.() ?? '');
      nextCursor = encodeCursor(cursorRaw);
    }

    return { items, nextCursor };
  },

  async create(
    network_id: string,
    data: Omit<Network, 'network_id' | 'created_at' | 'updated_at'>
  ): Promise<Network> {
    const ref = db().collection(COLLECTIONS.NETWORKS).doc(network_id);
    const exists = (await ref.get()).exists;
    if (exists) throw new Error('network_already_exists');

    const payload = {
      ...data,
      name_lower: data.name?.toLowerCase() ?? '',
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    };
    await ref.set(payload);
    cache.delete(network_id);
    const snap = await ref.get();
    return { network_id, ...(snap.data() as Omit<Network, 'network_id'>) };
  },

  async update(
    network_id: string,
    patch: Partial<Omit<Network, 'network_id' | 'created_at'>>
  ): Promise<Network | null> {
    const ref = db().collection(COLLECTIONS.NETWORKS).doc(network_id);
    const exists = (await ref.get()).exists;
    if (!exists) return null;

    const update: Record<string, unknown> = { ...patch, updated_at: FieldValue.serverTimestamp() };
    if (patch.name) update.name_lower = patch.name.toLowerCase();
    await ref.update(update);
    cache.delete(network_id);
    const snap = await ref.get();
    return { network_id, ...(snap.data() as Omit<Network, 'network_id'>) };
  },

  async delete(network_id: string): Promise<boolean> {
    const ref = db().collection(COLLECTIONS.NETWORKS).doc(network_id);
    const exists = (await ref.get()).exists;
    if (!exists) return false;
    await ref.delete();
    cache.delete(network_id);
    return true;
  },

  invalidate(network_id?: string): void {
    if (network_id) cache.delete(network_id);
    else cache.clear();
  },
};
