import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';

// GA4 integration preferences. Singleton in app_state, same pattern as
// googleAdsSyncStateRepository.
//
// `audit_enabled` controls whether every upload attempt is written to the
// `ga4_uploads` collection (the GA4 Uploads tab + CSV export read it). Turning
// it off keeps forwarding working exactly the same - outcomes still go to the
// structured logs - but nothing is stored, so the collection stops growing.

const DOC_ID = 'ga4_settings';

export interface Ga4Settings {
  audit_enabled: boolean;
  updated_at: string | null;
}

const DEFAULTS: Ga4Settings = { audit_enabled: true, updated_at: null };

// The forwarder reads this on every upload; cache briefly so a burst of
// conversions costs one read. Writes invalidate immediately, and other Cloud
// Run instances pick the change up within the TTL.
const TTL_MS = 60_000;
let cache: { value: Ga4Settings; expires: number } | null = null;

export const ga4SettingsRepository = {
  async get(): Promise<Ga4Settings> {
    if (cache && cache.expires > Date.now()) return cache.value;
    const snap = await db().collection(COLLECTIONS.APP_STATE).doc(DOC_ID).get();
    const raw = snap.exists ? snap.data() ?? {} : {};
    const value: Ga4Settings = {
      audit_enabled: raw.audit_enabled !== false,
      updated_at: (raw.updated_at as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString() ?? null,
    };
    cache = { value, expires: Date.now() + TTL_MS };
    return value;
  },

  /** Audit flag only; never throws into the upload path (defaults to on). */
  async auditEnabled(): Promise<boolean> {
    try {
      return (await this.get()).audit_enabled;
    } catch {
      return DEFAULTS.audit_enabled;
    }
  },

  async update(patch: { audit_enabled: boolean }): Promise<Ga4Settings> {
    await db()
      .collection(COLLECTIONS.APP_STATE)
      .doc(DOC_ID)
      .set({ audit_enabled: patch.audit_enabled, updated_at: FieldValue.serverTimestamp() }, { merge: true });
    cache = null;
    return this.get();
  },
};
