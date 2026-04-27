import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { GoogleAdsConnection, GoogleAdsConnectionType } from '../../types/googleAds';

const TTL_MS = 30_000;
const cache = new Map<string, { conn: GoogleAdsConnection; expires: number }>();

function fromDoc(id: string, raw: Record<string, unknown>): GoogleAdsConnection {
  const created = (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.();
  const updated = (raw.updated_at as { toDate?: () => Date } | undefined)?.toDate?.();
  return {
    connection_id: id,
    type: raw.type as GoogleAdsConnectionType,
    google_user_email: String(raw.google_user_email ?? ''),
    refresh_token_enc: raw.refresh_token_enc as GoogleAdsConnection['refresh_token_enc'],
    customer_id: String(raw.customer_id ?? ''),
    manager_customer_id: raw.manager_customer_id as string | undefined,
    descriptive_name: String(raw.descriptive_name ?? ''),
    currency_code: String(raw.currency_code ?? ''),
    time_zone: String(raw.time_zone ?? ''),
    sale_conversion_action_resource: raw.sale_conversion_action_resource as string | undefined,
    sale_conversion_action_name: raw.sale_conversion_action_name as string | undefined,
    click_conversion_action_resource: raw.click_conversion_action_resource as string | undefined,
    click_conversion_action_name: raw.click_conversion_action_name as string | undefined,
    scopes: Array.isArray(raw.scopes) ? (raw.scopes as string[]) : [],
    status: (raw.status as GoogleAdsConnection['status']) ?? 'active',
    last_error: raw.last_error as string | undefined,
    created_at: created?.toISOString(),
    updated_at: updated?.toISOString(),
  };
}

export const googleAdsConnectionRepository = {
  async insert(conn: Omit<GoogleAdsConnection, 'created_at' | 'updated_at'>): Promise<GoogleAdsConnection> {
    const ref = db().collection(COLLECTIONS.GOOGLE_ADS_CONNECTIONS).doc(conn.connection_id);
    await ref.set({
      type: conn.type,
      google_user_email: conn.google_user_email,
      refresh_token_enc: conn.refresh_token_enc,
      customer_id: conn.customer_id,
      manager_customer_id: conn.manager_customer_id,
      descriptive_name: conn.descriptive_name,
      currency_code: conn.currency_code,
      time_zone: conn.time_zone,
      sale_conversion_action_resource: conn.sale_conversion_action_resource,
      sale_conversion_action_name: conn.sale_conversion_action_name,
      click_conversion_action_resource: conn.click_conversion_action_resource,
      click_conversion_action_name: conn.click_conversion_action_name,
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

  async getById(connection_id: string): Promise<GoogleAdsConnection | null> {
    const now = Date.now();
    const hit = cache.get(connection_id);
    if (hit && hit.expires > now) return hit.conn;
    const snap = await db().collection(COLLECTIONS.GOOGLE_ADS_CONNECTIONS).doc(connection_id).get();
    if (!snap.exists) return null;
    const conn = fromDoc(connection_id, snap.data() ?? {});
    cache.set(connection_id, { conn, expires: now + TTL_MS });
    return conn;
  },

  async list(): Promise<GoogleAdsConnection[]> {
    const snap = await db()
      .collection(COLLECTIONS.GOOGLE_ADS_CONNECTIONS)
      .orderBy('created_at', 'desc')
      .limit(100)
      .get();
    return snap.docs.map((d) => fromDoc(d.id, d.data()));
  },

  async listByType(type: GoogleAdsConnectionType): Promise<GoogleAdsConnection[]> {
    const snap = await db()
      .collection(COLLECTIONS.GOOGLE_ADS_CONNECTIONS)
      .where('type', '==', type)
      .get();
    return snap.docs.map((d) => fromDoc(d.id, d.data()));
  },

  async update(
    connection_id: string,
    patch: Partial<Pick<
      GoogleAdsConnection,
      | 'status'
      | 'last_error'
      | 'refresh_token_enc'
      | 'descriptive_name'
      | 'currency_code'
      | 'time_zone'
      | 'sale_conversion_action_resource'
      | 'sale_conversion_action_name'
      | 'click_conversion_action_resource'
      | 'click_conversion_action_name'
    >>
  ): Promise<GoogleAdsConnection | null> {
    const ref = db().collection(COLLECTIONS.GOOGLE_ADS_CONNECTIONS).doc(connection_id);
    const exists = (await ref.get()).exists;
    if (!exists) return null;
    await ref.update({ ...patch, updated_at: FieldValue.serverTimestamp() });
    cache.delete(connection_id);
    const snap = await ref.get();
    return fromDoc(connection_id, snap.data() ?? {});
  },

  async delete(connection_id: string): Promise<boolean> {
    const ref = db().collection(COLLECTIONS.GOOGLE_ADS_CONNECTIONS).doc(connection_id);
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
