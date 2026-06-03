import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { EncryptedBlob } from '../../utils/crypto';
import type { FacebookCandidate, FacebookConnectionType } from '../../types/facebookAds';

// Short-lived holding pen for OAuth callback state. See COLLECTIONS docblock
// for why this exists. TTL is enforced both by an `expires_at` field (checked
// at consume time) and by deleting the doc on first successful consume.
//
// Schema: facebook_oauth_sessions/{session_id}
//   admin_email                string   — who started the flow; the consumer
//                                          must be logged in as this same admin
//   access_token_enc           map       AES-GCM blob of the long-lived token
//   access_token_expires_at    string   ISO
//   meta_user_email            string   from /me
//   scopes                     string[]
//   type                       'business' | 'ad_account'
//   candidates                 array    discovered BMs + ad accounts
//   expires_at                 Timestamp 5 min from creation; consumer rejects if past
//   created_at                 Timestamp

export interface FacebookOauthSessionDoc {
  session_id: string;
  admin_email: string;
  access_token_enc: EncryptedBlob;
  access_token_expires_at?: string;
  meta_user_email: string;
  scopes: string[];
  type: FacebookConnectionType;
  candidates: FacebookCandidate[];
  expires_at: string;
  created_at?: string;
}

const SESSION_TTL_MS = 5 * 60 * 1000;

function fromDoc(id: string, raw: Record<string, unknown>): FacebookOauthSessionDoc {
  const expiresAt = (raw.expires_at as Timestamp | undefined);
  const createdAt = (raw.created_at as Timestamp | undefined);
  return {
    session_id: id,
    admin_email: String(raw.admin_email ?? ''),
    access_token_enc: raw.access_token_enc as EncryptedBlob,
    access_token_expires_at: raw.access_token_expires_at as string | undefined,
    meta_user_email: String(raw.meta_user_email ?? ''),
    scopes: Array.isArray(raw.scopes) ? (raw.scopes as string[]) : [],
    type: raw.type as FacebookConnectionType,
    candidates: Array.isArray(raw.candidates) ? (raw.candidates as FacebookCandidate[]) : [],
    expires_at: expiresAt
      ? expiresAt.toDate().toISOString()
      : (raw.expires_at as string | undefined) ?? new Date(0).toISOString(),
    created_at: createdAt?.toDate().toISOString(),
  };
}

export const facebookOauthSessionRepository = {
  async create(
    session_id: string,
    payload: Omit<FacebookOauthSessionDoc, 'session_id' | 'expires_at' | 'created_at'>
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db().collection(COLLECTIONS.FACEBOOK_OAUTH_SESSIONS).doc(session_id).set({
      admin_email: payload.admin_email,
      access_token_enc: payload.access_token_enc,
      access_token_expires_at: payload.access_token_expires_at,
      meta_user_email: payload.meta_user_email,
      scopes: payload.scopes,
      type: payload.type,
      candidates: payload.candidates,
      expires_at: Timestamp.fromDate(expiresAt),
      created_at: FieldValue.serverTimestamp(),
    });
  },

  // Atomic consume — read, validate expiry + admin_email, delete. Returns the
  // doc on success; throws on validation failure so the controller can surface
  // a specific error code.
  async consume(session_id: string, expectedAdminEmail: string): Promise<FacebookOauthSessionDoc> {
    return await db().runTransaction(async (tx) => {
      const ref = db().collection(COLLECTIONS.FACEBOOK_OAUTH_SESSIONS).doc(session_id);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('session_not_found');
      const doc = fromDoc(session_id, snap.data() ?? {});
      if (new Date(doc.expires_at).getTime() < Date.now()) {
        tx.delete(ref);
        throw new Error('session_expired');
      }
      if (doc.admin_email.toLowerCase() !== expectedAdminEmail.toLowerCase()) {
        throw new Error('session_admin_mismatch');
      }
      tx.delete(ref);
      return doc;
    });
  },
};
