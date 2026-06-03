import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';

// Singleton app_state doc. Mirror of ./googleAdsSyncStateRepository.ts.

const DOC_ID = 'facebook_sync';

export interface FacebookSyncState {
  pref_from: string | null;
  pref_to: string | null;
  pref_updated_at: string | null;
  last_synced_at: string | null;
  last_sync_from: string | null;
  last_sync_to: string | null;
}

const EMPTY: FacebookSyncState = {
  pref_from: null,
  pref_to: null,
  pref_updated_at: null,
  last_synced_at: null,
  last_sync_from: null,
  last_sync_to: null,
};

function fromDoc(raw: Record<string, unknown>): FacebookSyncState {
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

export const facebookSyncStateRepository = {
  async get(): Promise<FacebookSyncState> {
    const snap = await db().collection(COLLECTIONS.APP_STATE).doc(DOC_ID).get();
    if (!snap.exists) return EMPTY;
    return fromDoc(snap.data() ?? {});
  },

  async savePrefs(prefs: { from: string; to: string }): Promise<FacebookSyncState> {
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
