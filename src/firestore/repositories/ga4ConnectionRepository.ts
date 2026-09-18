import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { EncryptedBlob } from '../../utils/crypto';

// GA4 integration storage, set up from the Connections tab:
//
//   ga4_connections/{connection_id}   one Google sign-in (OAuth refresh token,
//                                     encrypted) with Analytics edit access
//   ga4_streams/{measurement_id}      a GA4 web data stream linked for
//                                     conversion forwarding, holding the
//                                     Measurement Protocol API secret the
//                                     tracker created on that stream
//
// The stream doc id is the measurement id (G-XXXX) because that is exactly
// what a click carries in `extra_params.ga_mid`, so the forwarder resolves the
// secret with a single doc read.

export type Ga4ConnectionStatus = 'active' | 'error';

export interface Ga4Connection {
  connection_id: string;
  google_user_email: string;
  refresh_token_enc: EncryptedBlob;
  scopes: string[];
  status: Ga4ConnectionStatus;
  last_error?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Ga4Stream {
  measurement_id: string;
  connection_id: string;
  account_name?: string;
  property_id: string;
  property_name?: string;
  stream_id: string;
  stream_name?: string;
  default_uri?: string;
  api_secret_enc: EncryptedBlob;
  api_secret_name?: string;
  // Property settings from the Admin API - the upload currency defaults to
  // the property's currency, like Google Ads defaults to the account's.
  currency_code?: string;
  time_zone?: string;
  // ≈ Google Ads sale / click conversion actions. sale defaults to `purchase`;
  // click is unset by default, so outbound clicks are only uploaded once the
  // operator picks an event name for them.
  sale_event_name?: string;
  click_event_name?: string;
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

function iso(v: unknown): string | undefined {
  return (v as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString();
}

function connectionFromDoc(id: string, raw: Record<string, unknown>): Ga4Connection {
  return {
    connection_id: id,
    google_user_email: String(raw.google_user_email ?? ''),
    refresh_token_enc: raw.refresh_token_enc as EncryptedBlob,
    scopes: Array.isArray(raw.scopes) ? (raw.scopes as string[]) : [],
    status: (raw.status as Ga4ConnectionStatus) ?? 'active',
    last_error: raw.last_error as string | undefined,
    created_at: iso(raw.created_at),
    updated_at: iso(raw.updated_at),
  };
}

function streamFromDoc(id: string, raw: Record<string, unknown>): Ga4Stream {
  return {
    measurement_id: id,
    connection_id: String(raw.connection_id ?? ''),
    account_name: raw.account_name as string | undefined,
    property_id: String(raw.property_id ?? ''),
    property_name: raw.property_name as string | undefined,
    stream_id: String(raw.stream_id ?? ''),
    stream_name: raw.stream_name as string | undefined,
    default_uri: raw.default_uri as string | undefined,
    api_secret_enc: raw.api_secret_enc as EncryptedBlob,
    api_secret_name: raw.api_secret_name as string | undefined,
    currency_code: raw.currency_code as string | undefined,
    time_zone: raw.time_zone as string | undefined,
    sale_event_name: raw.sale_event_name as string | undefined,
    click_event_name: raw.click_event_name as string | undefined,
    enabled: raw.enabled !== false,
    created_at: iso(raw.created_at),
    updated_at: iso(raw.updated_at),
  };
}

// The postback hot path looks streams up by measurement id; cache briefly so
// a burst of conversions costs one read. Writes invalidate immediately.
const STREAM_TTL_MS = 60_000;
const streamCache = new Map<string, { stream: Ga4Stream | null; expires: number }>();

export const ga4ConnectionRepository = {
  async insert(conn: Omit<Ga4Connection, 'created_at' | 'updated_at'>): Promise<void> {
    await db().collection(COLLECTIONS.GA4_CONNECTIONS).doc(conn.connection_id).set({
      google_user_email: conn.google_user_email,
      refresh_token_enc: conn.refresh_token_enc,
      scopes: conn.scopes,
      status: conn.status,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });
  },

  async get(connection_id: string): Promise<Ga4Connection | null> {
    if (!connection_id || connection_id.includes('/')) return null;
    const snap = await db().collection(COLLECTIONS.GA4_CONNECTIONS).doc(connection_id).get();
    return snap.exists ? connectionFromDoc(snap.id, snap.data() ?? {}) : null;
  },

  async list(): Promise<Ga4Connection[]> {
    const snap = await db().collection(COLLECTIONS.GA4_CONNECTIONS).get();
    return snap.docs
      .map((d) => connectionFromDoc(d.id, d.data()))
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  },

  async setStatus(connection_id: string, status: Ga4ConnectionStatus, last_error?: string): Promise<void> {
    await db().collection(COLLECTIONS.GA4_CONNECTIONS).doc(connection_id).set(
      {
        status,
        last_error: last_error ?? FieldValue.delete(),
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  },

  /** Deletes the connection AND every stream linked through it. */
  async delete(connection_id: string): Promise<void> {
    const streams = await db()
      .collection(COLLECTIONS.GA4_STREAMS)
      .where('connection_id', '==', connection_id)
      .get();
    const batch = db().batch();
    for (const s of streams.docs) {
      batch.delete(s.ref);
      streamCache.delete(s.id);
    }
    batch.delete(db().collection(COLLECTIONS.GA4_CONNECTIONS).doc(connection_id));
    await batch.commit();
  },
};

export const ga4StreamRepository = {
  async upsert(stream: Omit<Ga4Stream, 'created_at' | 'updated_at'>): Promise<void> {
    const ref = db().collection(COLLECTIONS.GA4_STREAMS).doc(stream.measurement_id);
    const exists = (await ref.get()).exists;
    await ref.set(
      {
        ...stream,
        ...(exists ? {} : { created_at: FieldValue.serverTimestamp() }),
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    streamCache.delete(stream.measurement_id);
  },

  async list(): Promise<Ga4Stream[]> {
    const snap = await db().collection(COLLECTIONS.GA4_STREAMS).get();
    return snap.docs.map((d) => streamFromDoc(d.id, d.data()));
  },

  async get(measurement_id: string): Promise<Ga4Stream | null> {
    if (!measurement_id || measurement_id.includes('/')) return null;
    const cached = streamCache.get(measurement_id);
    if (cached && cached.expires > Date.now()) return cached.stream;
    const snap = await db().collection(COLLECTIONS.GA4_STREAMS).doc(measurement_id).get();
    const stream = snap.exists ? streamFromDoc(snap.id, snap.data() ?? {}) : null;
    streamCache.set(measurement_id, { stream, expires: Date.now() + STREAM_TTL_MS });
    return stream;
  },

  async update(
    measurement_id: string,
    patch: { enabled?: boolean; sale_event_name?: string; click_event_name?: string | null }
  ): Promise<void> {
    const data: Record<string, unknown> = { updated_at: FieldValue.serverTimestamp() };
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.sale_event_name !== undefined) data.sale_event_name = patch.sale_event_name;
    if (patch.click_event_name !== undefined) {
      data.click_event_name = patch.click_event_name === null ? FieldValue.delete() : patch.click_event_name;
    }
    await db().collection(COLLECTIONS.GA4_STREAMS).doc(measurement_id).set(data, { merge: true });
    streamCache.delete(measurement_id);
  },

  async delete(measurement_id: string): Promise<void> {
    await db().collection(COLLECTIONS.GA4_STREAMS).doc(measurement_id).delete();
    streamCache.delete(measurement_id);
  },
};
