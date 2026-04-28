import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { AffiliateApi, AffiliateApiRunRecord } from '../../types';
import type { ListOptions, ListResult } from './offerRepository';

const TTL_MS = 30_000;
const cache = new Map<string, { api: AffiliateApi; expires: number }>();

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

function tsToIso(v: unknown): string | undefined {
  if (!v) return undefined;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (typeof v === 'object' && v && 'toDate' in (v as object)) {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof v === 'string') return v;
  return undefined;
}

function hydrate(id: string, data: Record<string, unknown>): AffiliateApi {
  const sched = (data.schedule ?? {}) as Record<string, unknown>;
  return {
    ...(data as unknown as AffiliateApi),
    api_id: id,
    schedule: {
      enabled: Boolean(sched.enabled ?? true),
      runs_per_day: typeof sched.runs_per_day === 'number' ? (sched.runs_per_day as number) : 4,
      next_run_at: tsToIso(sched.next_run_at),
      last_run_at: tsToIso(sched.last_run_at),
      last_status: sched.last_status as AffiliateApi['schedule']['last_status'],
    },
    lock_until: tsToIso(data.lock_until),
    created_at: tsToIso(data.created_at),
    updated_at: tsToIso(data.updated_at),
  };
}

export const affiliateApiRepository = {
  async getById(api_id: string): Promise<AffiliateApi | null> {
    const now = Date.now();
    const hit = cache.get(api_id);
    if (hit && hit.expires > now) return hit.api;

    const snap = await db().collection(COLLECTIONS.AFFILIATE_APIS).doc(api_id).get();
    if (!snap.exists) {
      cache.delete(api_id);
      return null;
    }
    const api = hydrate(api_id, snap.data() as Record<string, unknown>);
    cache.set(api_id, { api, expires: now + TTL_MS });
    return api;
  },

  async list(opts: ListOptions = {}): Promise<ListResult<AffiliateApi>> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const col = db().collection(COLLECTIONS.AFFILIATE_APIS);
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

    const items = docs.map((d) => hydrate(d.id, d.data() as Record<string, unknown>));

    let nextCursor: string | null = null;
    if (hasMore && docs.length > 0) {
      const last = docs[docs.length - 1]!;
      const data = last.data();
      const cursorRaw = opts.q
        ? String(data.name_lower ?? '')
        : String((data.created_at as Timestamp | undefined)?.toDate?.()?.toISOString?.() ?? '');
      nextCursor = encodeCursor(cursorRaw);
    }

    return { items, nextCursor };
  },

  async create(
    api_id: string,
    data: Omit<AffiliateApi, 'api_id' | 'created_at' | 'updated_at' | 'lock_holder' | 'lock_until'>
  ): Promise<AffiliateApi> {
    const ref = db().collection(COLLECTIONS.AFFILIATE_APIS).doc(api_id);
    const exists = (await ref.get()).exists;
    if (exists) throw new Error('affiliate_api_already_exists');

    const payload: Record<string, unknown> = {
      ...data,
      name_lower: data.name?.toLowerCase() ?? '',
      schedule: {
        ...data.schedule,
        next_run_at: data.schedule.enabled
          ? Timestamp.fromDate(new Date())
          : null,
      },
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    };
    await ref.set(payload);
    cache.delete(api_id);
    const snap = await ref.get();
    return hydrate(api_id, snap.data() as Record<string, unknown>);
  },

  async update(
    api_id: string,
    patch: Partial<Omit<AffiliateApi, 'api_id' | 'created_at'>>
  ): Promise<AffiliateApi | null> {
    const ref = db().collection(COLLECTIONS.AFFILIATE_APIS).doc(api_id);
    const exists = (await ref.get()).exists;
    if (!exists) return null;

    const update: Record<string, unknown> = { updated_at: FieldValue.serverTimestamp() };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      update[k] = v;
    }
    if (patch.name) update.name_lower = patch.name.toLowerCase();
    // If schedule enabled flipped on without an explicit next_run_at, run asap.
    if (patch.schedule && patch.schedule.enabled && !patch.schedule.next_run_at) {
      update.schedule = {
        ...patch.schedule,
        next_run_at: Timestamp.fromDate(new Date()),
      };
    }

    await ref.update(update);
    cache.delete(api_id);
    const snap = await ref.get();
    return hydrate(api_id, snap.data() as Record<string, unknown>);
  },

  async delete(api_id: string): Promise<boolean> {
    const ref = db().collection(COLLECTIONS.AFFILIATE_APIS).doc(api_id);
    const exists = (await ref.get()).exists;
    if (!exists) return false;
    await ref.delete();
    cache.delete(api_id);
    return true;
  },

  // Scheduler entrypoint. Returns active APIs whose next_run_at <= now.
  // Intentionally narrow projection to keep the read cheap at scale.
  async listDue(now: Date, max: number): Promise<AffiliateApi[]> {
    const snap = await db()
      .collection(COLLECTIONS.AFFILIATE_APIS)
      .where('status', '==', 'active')
      .where('schedule.next_run_at', '<=', Timestamp.fromDate(now))
      .orderBy('schedule.next_run_at', 'asc')
      .limit(max)
      .get();
    return snap.docs.map((d) => hydrate(d.id, d.data() as Record<string, unknown>));
  },

  // Cooperative lock via Firestore transaction. Holder writes its id + lease
  // expiry; concurrent claimants see the live lease and back off. The lease
  // is short (default 10 min) so a crashed runner unblocks itself.
  async tryAcquireLock(api_id: string, holder: string, leaseMs: number): Promise<boolean> {
    const ref = db().collection(COLLECTIONS.AFFILIATE_APIS).doc(api_id);
    const ok = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const data = snap.data() as Record<string, unknown>;
      const until = data.lock_until as Timestamp | undefined;
      const stillHeld = until && until.toMillis() > Date.now();
      if (stillHeld && data.lock_holder !== holder) return false;
      tx.update(ref, {
        lock_holder: holder,
        lock_until: Timestamp.fromMillis(Date.now() + leaseMs),
      });
      return true;
    });
    if (ok) cache.delete(api_id);
    return ok;
  },

  async releaseLock(api_id: string, holder: string): Promise<void> {
    const ref = db().collection(COLLECTIONS.AFFILIATE_APIS).doc(api_id);
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      if ((snap.data() as Record<string, unknown>).lock_holder !== holder) return;
      tx.update(ref, { lock_holder: FieldValue.delete(), lock_until: FieldValue.delete() });
    });
    cache.delete(api_id);
  },

  async recordRunOutcome(
    api_id: string,
    nextRunAt: Date,
    last_run_at: Date,
    last_status: AffiliateApi['schedule']['last_status']
  ): Promise<void> {
    const ref = db().collection(COLLECTIONS.AFFILIATE_APIS).doc(api_id);
    await ref.update({
      'schedule.next_run_at': Timestamp.fromDate(nextRunAt),
      'schedule.last_run_at': Timestamp.fromDate(last_run_at),
      'schedule.last_status': last_status,
      updated_at: FieldValue.serverTimestamp(),
    });
    cache.delete(api_id);
  },

  invalidate(api_id?: string): void {
    if (api_id) cache.delete(api_id);
    else cache.clear();
  },
};

export const affiliateApiRunRepository = {
  async insert(run: AffiliateApiRunRecord): Promise<void> {
    await db()
      .collection(COLLECTIONS.AFFILIATE_API_RUNS)
      .doc(run.run_id)
      .set({
        ...run,
        started_at: run.started_at ? Timestamp.fromDate(new Date(run.started_at)) : FieldValue.serverTimestamp(),
        finished_at: run.finished_at ? Timestamp.fromDate(new Date(run.finished_at)) : null,
      });
  },

  async update(run_id: string, patch: Partial<AffiliateApiRunRecord>): Promise<void> {
    const update: Record<string, unknown> = { ...patch };
    if (patch.finished_at) update.finished_at = Timestamp.fromDate(new Date(patch.finished_at));
    if (patch.started_at) update.started_at = Timestamp.fromDate(new Date(patch.started_at));
    await db().collection(COLLECTIONS.AFFILIATE_API_RUNS).doc(run_id).update(update);
  },

  async listByApi(api_id: string, limit = 25): Promise<AffiliateApiRunRecord[]> {
    const snap = await db()
      .collection(COLLECTIONS.AFFILIATE_API_RUNS)
      .where('api_id', '==', api_id)
      .orderBy('started_at', 'desc')
      .limit(Math.min(Math.max(limit, 1), 200))
      .get();
    return snap.docs.map((d) => {
      const raw = d.data() as Record<string, unknown>;
      return {
        ...(raw as unknown as AffiliateApiRunRecord),
        run_id: d.id,
        started_at: tsToIso(raw.started_at) ?? '',
        finished_at: tsToIso(raw.finished_at),
      };
    });
  },
};
