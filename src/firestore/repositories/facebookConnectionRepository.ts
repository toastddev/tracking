import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { FacebookConnection, FacebookConnectionType } from '../../types/facebookAds';

// Direct mirror of ./googleAdsConnectionRepository.ts. 2-hour TTL because the
// connection record is read on every CAPI dispatch — the hot path expects the
// access token to be cached.

const TTL_MS = 7_200_000;
const cache = new Map<string, { conn: FacebookConnection; expires: number }>();

function fromDoc(id: string, raw: Record<string, unknown>): FacebookConnection {
  const created = (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.();
  const updated = (raw.updated_at as { toDate?: () => Date } | undefined)?.toDate?.();
  return {
    connection_id: id,
    type: raw.type as FacebookConnectionType,
    meta_user_email: String(raw.meta_user_email ?? ''),
    access_token_enc: raw.access_token_enc as FacebookConnection['access_token_enc'],
    access_token_expires_at: raw.access_token_expires_at as string | undefined,
    business_id: raw.business_id as string | undefined,
    ad_account_id: String(raw.ad_account_id ?? ''),
    dataset_id: raw.dataset_id as string | undefined,
    dataset_name: raw.dataset_name as string | undefined,
    name: String(raw.name ?? ''),
    currency_code: String(raw.currency_code ?? ''),
    time_zone: String(raw.time_zone ?? ''),
    account_status: raw.account_status as string | undefined,
    sale_event_name: raw.sale_event_name as string | undefined,
    sale_event_dataset_id: raw.sale_event_dataset_id as string | undefined,
    click_event_name: raw.click_event_name as string | undefined,
    click_event_dataset_id: raw.click_event_dataset_id as string | undefined,
    scopes: Array.isArray(raw.scopes) ? (raw.scopes as string[]) : [],
    status: (raw.status as FacebookConnection['status']) ?? 'active',
    last_error: raw.last_error as string | undefined,
    created_at: created?.toISOString(),
    updated_at: updated?.toISOString(),
  };
}

export const facebookConnectionRepository = {
  async insert(conn: Omit<FacebookConnection, 'created_at' | 'updated_at'>): Promise<FacebookConnection> {
    const ref = db().collection(COLLECTIONS.FACEBOOK_CONNECTIONS).doc(conn.connection_id);
    await ref.set({
      type: conn.type,
      meta_user_email: conn.meta_user_email,
      access_token_enc: conn.access_token_enc,
      access_token_expires_at: conn.access_token_expires_at,
      business_id: conn.business_id,
      ad_account_id: conn.ad_account_id,
      dataset_id: conn.dataset_id,
      dataset_name: conn.dataset_name,
      name: conn.name,
      currency_code: conn.currency_code,
      time_zone: conn.time_zone,
      account_status: conn.account_status,
      sale_event_name: conn.sale_event_name,
      sale_event_dataset_id: conn.sale_event_dataset_id,
      click_event_name: conn.click_event_name,
      click_event_dataset_id: conn.click_event_dataset_id,
      scopes: conn.scopes,
      status: conn.status,
      last_error: conn.last_error,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });
    cache.delete(conn.connection_id);
    const snap = await ref.get();
    return fromDoc(conn.connection_id, snap.data() ?? {});
  },

  async getById(connection_id: string): Promise<FacebookConnection | null> {
    const now = Date.now();
    const hit = cache.get(connection_id);
    if (hit && hit.expires > now) return hit.conn;
    const snap = await db().collection(COLLECTIONS.FACEBOOK_CONNECTIONS).doc(connection_id).get();
    if (!snap.exists) return null;
    const conn = fromDoc(connection_id, snap.data() ?? {});
    cache.set(connection_id, { conn, expires: now + TTL_MS });
    return conn;
  },

  async list(): Promise<FacebookConnection[]> {
    const snap = await db()
      .collection(COLLECTIONS.FACEBOOK_CONNECTIONS)
      .orderBy('created_at', 'desc')
      .limit(100)
      .get();
    return snap.docs.map((d) => fromDoc(d.id, d.data()));
  },

  async listByType(type: FacebookConnectionType): Promise<FacebookConnection[]> {
    const snap = await db()
      .collection(COLLECTIONS.FACEBOOK_CONNECTIONS)
      .where('type', '==', type)
      .get();
    return snap.docs.map((d) => fromDoc(d.id, d.data()));
  },

  async update(
    connection_id: string,
    patch: Partial<Pick<
      FacebookConnection,
      | 'status'
      | 'last_error'
      | 'access_token_enc'
      | 'access_token_expires_at'
      | 'name'
      | 'currency_code'
      | 'time_zone'
      | 'account_status'
      | 'dataset_id'
      | 'dataset_name'
      | 'sale_event_name'
      | 'sale_event_dataset_id'
      | 'click_event_name'
      | 'click_event_dataset_id'
    >>
  ): Promise<FacebookConnection | null> {
    const ref = db().collection(COLLECTIONS.FACEBOOK_CONNECTIONS).doc(connection_id);
    const exists = (await ref.get()).exists;
    if (!exists) return null;
    await ref.update({ ...patch, updated_at: FieldValue.serverTimestamp() });
    cache.delete(connection_id);
    const snap = await ref.get();
    return fromDoc(connection_id, snap.data() ?? {});
  },

  async delete(connection_id: string): Promise<boolean> {
    const ref = db().collection(COLLECTIONS.FACEBOOK_CONNECTIONS).doc(connection_id);
    const exists = (await ref.get()).exists;
    if (!exists) return false;
    await ref.delete();
    cache.delete(connection_id);
    return true;
  },

  invalidate(connection_id?: string): void {
    if (connection_id) cache.delete(connection_id);
    else cache.clear();
  },
};
