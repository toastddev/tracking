import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';

const DOC_ID = 'google_ads_sync';

export interface GoogleAdsSyncState {
  pref_from: string | null;       // YYYY-MM-DD, last user-chosen sync window start
  pref_to: string | null;         // YYYY-MM-DD, last user-chosen sync window end
  pref_updated_at: string | null; // ISO timestamp
  last_synced_at: string | null;  // ISO timestamp of the last successful sync
  last_sync_from: string | null;  // YYYY-MM-DD actually used by the last sync
  last_sync_to: string | null;    // YYYY-MM-DD actually used by the last sync
}

const EMPTY: GoogleAdsSyncState = {
  pref_from: null,
  pref_to: null,
  pref_updated_at: null,
  last_synced_at: null,
  last_sync_from: null,
  last_sync_to: null,
};

function fromDoc(raw: Record<string, unknown>): GoogleAdsSyncState {
  const prefUpdated = (raw.pref_updated_at as { toDate?: () => Date } | undefined)?.toDate?.();
  const lastSynced = (raw.last_synced_at as { toDate?: () => Date } | undefined)?.toDate?.();
  return {
    pref_from: (raw.pref_from as string | null | undefined) ?? null,
    pref_to: (raw.pref_to as string | null | undefined) ?? null,
    pref_updated_at: prefUpdated?.toISOString() ?? null,
    last_synced_at: lastSynced?.toISOString() ?? null,
    last_sync_from: (raw.last_sync_from as string | null | undefined) ?? null,
    last_sync_to: (raw.last_sync_to as string | null | undefined) ?? null,
  };
}

export const googleAdsSyncStateRepository = {
  async get(): Promise<GoogleAdsSyncState> {
    const snap = await db().collection(COLLECTIONS.APP_STATE).doc(DOC_ID).get();
    if (!snap.exists) return EMPTY;
    return fromDoc(snap.data() ?? {});
  },

  async savePrefs(prefs: { from: string; to: string }): Promise<GoogleAdsSyncState> {
    const ref = db().collection(COLLECTIONS.APP_STATE).doc(DOC_ID);
    await ref.set(
      {
        pref_from: prefs.from,
        pref_to: prefs.to,
        pref_updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    const snap = await ref.get();
    return fromDoc(snap.data() ?? {});
  },

  async touchLastSynced(window: { from: string; to: string }): Promise<void> {
    const ref = db().collection(COLLECTIONS.APP_STATE).doc(DOC_ID);
    await ref.set(
      {
        last_synced_at: FieldValue.serverTimestamp(),
        last_sync_from: window.from,
        last_sync_to: window.to,
      },
      { merge: true }
    );
  },
};
