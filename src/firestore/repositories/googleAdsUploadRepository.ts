import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import { generateConversionId } from '../../utils/idGenerator';
import type { GoogleAdsUpload, GoogleAdsUploadKind } from '../../types/googleAds';

function fromDoc(id: string, raw: Record<string, unknown>): GoogleAdsUpload {
  const created = (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.();
  const updated = (raw.updated_at as { toDate?: () => Date } | undefined)?.toDate?.();
  const sent = (raw.sent_at as { toDate?: () => Date } | undefined)?.toDate?.();
  return {
    upload_id: id,
    kind: (raw.kind as GoogleAdsUploadKind) ?? 'conversion',
    source_id: String(raw.source_id ?? ''),
    conversion_id: raw.conversion_id as string | undefined,
    click_id: raw.click_id as string | undefined,
    connection_id: raw.connection_id as string | undefined,
    customer_id: raw.customer_id as string | undefined,
    identifier_type: raw.identifier_type as GoogleAdsUpload['identifier_type'],
    identifier_value: raw.identifier_value as string | undefined,
    conversion_action_resource: raw.conversion_action_resource as string | undefined,
    status: (raw.status as GoogleAdsUpload['status']) ?? 'pending',
    attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
    last_error: raw.last_error as string | undefined,
    skip_reason: raw.skip_reason as string | undefined,
    google_response: raw.google_response as Record<string, unknown> | undefined,
    sent_at: sent?.toISOString(),
    created_at: created?.toISOString(),
    updated_at: updated?.toISOString(),
  };
}

export const googleAdsUploadRepository = {
  // Each (kind, source, destination) attempt gets its own doc. New upload_id
  // per call so a single conversion fanned out to N MCCs + a child route
  // produces N+1 upload rows we can audit.
  async record(upload: Omit<GoogleAdsUpload, 'upload_id' | 'created_at' | 'updated_at'> & { upload_id?: string }): Promise<GoogleAdsUpload> {
    const upload_id = upload.upload_id ?? generateConversionId();
    const ref = db().collection(COLLECTIONS.GOOGLE_ADS_UPLOADS).doc(upload_id);
    const exists = (await ref.get()).exists;
    const payload: Record<string, unknown> = {
      kind: upload.kind,
      source_id: upload.source_id,
      conversion_id: upload.conversion_id,
      click_id: upload.click_id,
      connection_id: upload.connection_id,
      customer_id: upload.customer_id,
      identifier_type: upload.identifier_type,
      identifier_value: upload.identifier_value,
      conversion_action_resource: upload.conversion_action_resource,
      status: upload.status,
      attempts: upload.attempts,
      last_error: upload.last_error,
      skip_reason: upload.skip_reason,
      google_response: upload.google_response,
      sent_at: upload.sent_at ? new Date(upload.sent_at) : undefined,
      updated_at: FieldValue.serverTimestamp(),
    };
    if (!exists) payload.created_at = FieldValue.serverTimestamp();
    await ref.set(payload, { merge: true });
    const snap = await ref.get();
    return fromDoc(upload_id, snap.data() ?? {});
  },

  async getById(upload_id: string): Promise<GoogleAdsUpload | null> {
    const snap = await db().collection(COLLECTIONS.GOOGLE_ADS_UPLOADS).doc(upload_id).get();
    if (!snap.exists) return null;
    return fromDoc(upload_id, snap.data() ?? {});
  },

  async listForSource(source_id: string, kind?: GoogleAdsUploadKind): Promise<GoogleAdsUpload[]> {
    let q: FirebaseFirestore.Query = db()
      .collection(COLLECTIONS.GOOGLE_ADS_UPLOADS)
      .where('source_id', '==', source_id);
    if (kind) q = q.where('kind', '==', kind);
    const snap = await q.limit(50).get();
    return snap.docs.map((d) => fromDoc(d.id, d.data()));
  },
};
