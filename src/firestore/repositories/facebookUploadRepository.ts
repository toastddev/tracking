import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import { generateConversionId } from '../../utils/idGenerator';
import type { FacebookUpload, FacebookUploadKind } from '../../types/facebookAds';

// Mirror of ./googleAdsUploadRepository.ts. Each (kind, source, destination)
// attempt produces its own audit doc keyed by uuidv7. Same date-only Firestore
// query pattern for the CSV export so we don't fall onto a composite index.

function fromDoc(id: string, raw: Record<string, unknown>): FacebookUpload {
  const created = (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.();
  const updated = (raw.updated_at as { toDate?: () => Date } | undefined)?.toDate?.();
  const sent = (raw.sent_at as { toDate?: () => Date } | undefined)?.toDate?.();
  return {
    upload_id: id,
    kind: (raw.kind as FacebookUploadKind) ?? 'conversion',
    source_id: String(raw.source_id ?? ''),
    conversion_id: raw.conversion_id as string | undefined,
    click_id: raw.click_id as string | undefined,
    connection_id: raw.connection_id as string | undefined,
    ad_account_id: raw.ad_account_id as string | undefined,
    dataset_id: raw.dataset_id as string | undefined,
    event_name: raw.event_name as string | undefined,
    event_id: raw.event_id as string | undefined,
    identifier_type: raw.identifier_type as FacebookUpload['identifier_type'],
    identifier_value: raw.identifier_value as string | undefined,
    status: (raw.status as FacebookUpload['status']) ?? 'pending',
    attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
    last_error: raw.last_error as string | undefined,
    skip_reason: raw.skip_reason as string | undefined,
    meta_response: raw.meta_response as Record<string, unknown> | undefined,
    sent_at: sent?.toISOString(),
    created_at: created?.toISOString(),
    updated_at: updated?.toISOString(),
  };
}

export const facebookUploadRepository = {
  async record(upload: Omit<FacebookUpload, 'upload_id' | 'created_at' | 'updated_at'> & { upload_id?: string }): Promise<FacebookUpload> {
    const upload_id = upload.upload_id ?? generateConversionId();
    const ref = db().collection(COLLECTIONS.FACEBOOK_UPLOADS).doc(upload_id);
    const exists = (await ref.get()).exists;
    const payload: Record<string, unknown> = {
      kind: upload.kind,
      source_id: upload.source_id,
      conversion_id: upload.conversion_id,
      click_id: upload.click_id,
      connection_id: upload.connection_id,
      ad_account_id: upload.ad_account_id,
      dataset_id: upload.dataset_id,
      event_name: upload.event_name,
      event_id: upload.event_id,
      identifier_type: upload.identifier_type,
      identifier_value: upload.identifier_value,
      status: upload.status,
      attempts: upload.attempts,
      last_error: upload.last_error,
      skip_reason: upload.skip_reason,
      meta_response: upload.meta_response,
      sent_at: upload.sent_at ? new Date(upload.sent_at) : undefined,
      updated_at: FieldValue.serverTimestamp(),
    };
    if (!exists) payload.created_at = FieldValue.serverTimestamp();
    await ref.set(payload, { merge: true });
    const snap = await ref.get();
    return fromDoc(upload_id, snap.data() ?? {});
  },

  async getById(upload_id: string): Promise<FacebookUpload | null> {
    const snap = await db().collection(COLLECTIONS.FACEBOOK_UPLOADS).doc(upload_id).get();
    if (!snap.exists) return null;
    return fromDoc(upload_id, snap.data() ?? {});
  },

  async listForSource(source_id: string, kind?: FacebookUploadKind): Promise<FacebookUpload[]> {
    let q: FirebaseFirestore.Query = db()
      .collection(COLLECTIONS.FACEBOOK_UPLOADS)
      .where('source_id', '==', source_id);
    if (kind) q = q.where('kind', '==', kind);
    const snap = await q.limit(50).get();
    return snap.docs.map((d) => fromDoc(d.id, d.data()));
  },

  async fetchAllForExport(opts: {
    from: Date;
    to: Date;
    kind?: FacebookUploadKind;
    status?: FacebookUpload['status'];
    max: number;
  }): Promise<FacebookUpload[]> {
    const snap = await db()
      .collection(COLLECTIONS.FACEBOOK_UPLOADS)
      .where('created_at', '>=', opts.from)
      .where('created_at', '<=', opts.to)
      .orderBy('created_at', 'desc')
      .limit(opts.max)
      .get();

    const rows = snap.docs.map((d) => fromDoc(d.id, d.data()));
    if (!opts.kind && !opts.status) return rows;
    return rows.filter(
      (r) =>
        (!opts.kind || r.kind === opts.kind) &&
        (!opts.status || r.status === opts.status)
    );
  },
};
