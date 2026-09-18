import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import { generateConversionId } from '../../utils/idGenerator';

// Mirror of ./googleAdsUploadRepository.ts for GA4 Measurement Protocol
// uploads. Each (kind, source, destination) attempt gets its own audit doc
// keyed by uuidv7 - sent, failed and skipped (with reason) - so the GA4 upload
// report reads exactly like the Google Ads one. Same date-only Firestore query
// for the CSV export so we don't fall onto a composite index.

export type Ga4UploadKind = 'conversion' | 'click';
export type Ga4UploadStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface Ga4Upload {
  upload_id: string;
  kind: Ga4UploadKind;
  source_id: string;              // conversion_id (kind='conversion') or click_id (kind='click')
  conversion_id?: string;
  click_id?: string;
  connection_id?: string;         // GA4 connection the stream was linked through
  measurement_id?: string;        // destination (≈ Google Ads customer_id)
  identifier_type?: 'ga_client_id';
  identifier_value?: string;      // GA client_id from the click (≈ gclid)
  session_id?: string;
  event_name?: string;            // ≈ conversion_action_resource
  transaction_id?: string;        // = conversion_id (≈ order_id)
  value?: number;
  currency?: string;
  event_time?: string;            // ISO time sent as timestamp_micros, when sent
  status: Ga4UploadStatus;
  attempts: number;
  last_error?: string;
  skip_reason?: string;
  ga_response?: Record<string, unknown>;
  sent_at?: string;
  created_at?: string;
  updated_at?: string;
}

function iso(v: unknown): string | undefined {
  return (v as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString();
}

function fromDoc(id: string, raw: Record<string, unknown>): Ga4Upload {
  return {
    upload_id: id,
    kind: (raw.kind as Ga4UploadKind) ?? 'conversion',
    source_id: String(raw.source_id ?? ''),
    conversion_id: raw.conversion_id as string | undefined,
    click_id: raw.click_id as string | undefined,
    connection_id: raw.connection_id as string | undefined,
    measurement_id: raw.measurement_id as string | undefined,
    identifier_type: raw.identifier_type as Ga4Upload['identifier_type'],
    identifier_value: raw.identifier_value as string | undefined,
    session_id: raw.session_id as string | undefined,
    event_name: raw.event_name as string | undefined,
    transaction_id: raw.transaction_id as string | undefined,
    value: typeof raw.value === 'number' ? raw.value : undefined,
    currency: raw.currency as string | undefined,
    event_time: raw.event_time as string | undefined,
    status: (raw.status as Ga4UploadStatus) ?? 'pending',
    attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
    last_error: raw.last_error as string | undefined,
    skip_reason: raw.skip_reason as string | undefined,
    ga_response: raw.ga_response as Record<string, unknown> | undefined,
    sent_at: iso(raw.sent_at),
    created_at: iso(raw.created_at),
    updated_at: iso(raw.updated_at),
  };
}

export const ga4UploadRepository = {
  // New upload_id per call so a retry or a second destination produces its own
  // audit row, exactly like google_ads_uploads.
  async record(upload: Omit<Ga4Upload, 'upload_id' | 'created_at' | 'updated_at'> & { upload_id?: string }): Promise<Ga4Upload> {
    const upload_id = upload.upload_id ?? generateConversionId();
    const ref = db().collection(COLLECTIONS.GA4_UPLOADS).doc(upload_id);
    const exists = (await ref.get()).exists;
    const payload: Record<string, unknown> = {
      kind: upload.kind,
      source_id: upload.source_id,
      conversion_id: upload.conversion_id,
      click_id: upload.click_id,
      connection_id: upload.connection_id,
      measurement_id: upload.measurement_id,
      identifier_type: upload.identifier_type,
      identifier_value: upload.identifier_value,
      session_id: upload.session_id,
      event_name: upload.event_name,
      transaction_id: upload.transaction_id,
      value: upload.value,
      currency: upload.currency,
      event_time: upload.event_time,
      status: upload.status,
      attempts: upload.attempts,
      last_error: upload.last_error,
      skip_reason: upload.skip_reason,
      ga_response: upload.ga_response,
      sent_at: upload.sent_at ? new Date(upload.sent_at) : undefined,
      updated_at: FieldValue.serverTimestamp(),
    };
    if (!exists) payload.created_at = FieldValue.serverTimestamp();
    await ref.set(payload, { merge: true });
    const snap = await ref.get();
    return fromDoc(upload_id, snap.data() ?? {});
  },

  async listForSource(source_id: string, kind?: Ga4UploadKind): Promise<Ga4Upload[]> {
    let q: FirebaseFirestore.Query = db()
      .collection(COLLECTIONS.GA4_UPLOADS)
      .where('source_id', '==', source_id);
    if (kind) q = q.where('kind', '==', kind);
    const snap = await q.limit(50).get();
    return snap.docs.map((d) => fromDoc(d.id, d.data()));
  },

  /**
   * Newest-first page for the GA4 Uploads tab. created_at is the only Firestore
   * filter (so no composite index); kind / status are applied in memory, and
   * the cursor is the last row's created_at.
   */
  async listPage(opts: {
    from?: Date;
    to?: Date;
    kind?: Ga4UploadKind;
    status?: Ga4UploadStatus;
    limit: number;
    cursor?: string;
  }): Promise<{ items: Ga4Upload[]; next_cursor: string | null }> {
    const wanted = Math.min(Math.max(opts.limit, 1), 200);
    const items: Ga4Upload[] = [];
    let cursor = opts.cursor ? new Date(opts.cursor) : undefined;
    let next_cursor: string | null = null;

    // Scan in windows so in-memory filtering can still fill a page.
    for (let round = 0; round < 10 && items.length < wanted; round++) {
      let q: FirebaseFirestore.Query = db().collection(COLLECTIONS.GA4_UPLOADS);
      if (opts.from) q = q.where('created_at', '>=', opts.from);
      if (opts.to) q = q.where('created_at', '<=', opts.to);
      q = q.orderBy('created_at', 'desc');
      if (cursor && !Number.isNaN(cursor.getTime())) q = q.startAfter(cursor);
      const snap = await q.limit(wanted * 3).get();
      if (snap.empty) break;

      for (const d of snap.docs) {
        const row = fromDoc(d.id, d.data());
        cursor = (d.data().created_at as { toDate?: () => Date } | undefined)?.toDate?.() ?? cursor;
        if (opts.kind && row.kind !== opts.kind) continue;
        if (opts.status && row.status !== opts.status) continue;
        if (items.length < wanted) {
          items.push(row);
        } else {
          next_cursor = items[items.length - 1]?.created_at ?? null;
          break;
        }
      }
      if (snap.size < wanted * 3) break;
      if (items.length >= wanted) {
        next_cursor = items[items.length - 1]?.created_at ?? null;
        break;
      }
    }
    return { items, next_cursor };
  },

  // Same shape as googleAdsUploadRepository.fetchAllForExport: created_at is
  // the only Firestore filter, kind/status are applied in memory.
  async fetchAllForExport(opts: {
    from: Date;
    to: Date;
    kind?: Ga4UploadKind;
    status?: Ga4UploadStatus;
    max: number;
  }): Promise<Ga4Upload[]> {
    const snap = await db()
      .collection(COLLECTIONS.GA4_UPLOADS)
      .where('created_at', '>=', opts.from)
      .where('created_at', '<=', opts.to)
      .orderBy('created_at', 'desc')
      .limit(opts.max)
      .get();
    const rows = snap.docs.map((d) => fromDoc(d.id, d.data()));
    if (!opts.kind && !opts.status) return rows;
    return rows.filter(
      (r) => (!opts.kind || r.kind === opts.kind) && (!opts.status || r.status === opts.status)
    );
  },
};
