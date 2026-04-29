import { db } from '../firestore/config';
import { COLLECTIONS } from '../firestore/schema';
import { logger } from '../utils/logger';

const BATCH_SIZE = 400; // Firestore batches cap at 500 ops; leave headroom.

// Wipes one collection by repeatedly fetching the next BATCH_SIZE doc refs and
// deleting them in a single batched commit. Returns the total deleted.
async function wipeCollection(collection: string): Promise<number> {
  const col = db().collection(collection);
  let deleted = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await col.select().limit(BATCH_SIZE).get();
    if (snap.empty) break;
    const batch = db().batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += snap.size;
    if (snap.size < BATCH_SIZE) break;
  }
  return deleted;
}

export interface ResetDataResult {
  clicks: number;
  conversions: number;
  google_ads_uploads: number;
  offer_reports: number;
}

export const dataResetService = {
  // Hard wipe of every "incoming-data" collection. Configuration collections
  // (offers, networks, google_ads_connections, google_ads_routes,
  // google_ads_mcc_children) are deliberately untouched.
  async resetIncomingData(actor: string): Promise<ResetDataResult> {
    logger.warn('data_reset_started', { actor });
    const [clicks, conversions, uploads, offerReports] = await Promise.all([
      wipeCollection(COLLECTIONS.CLICKS),
      wipeCollection(COLLECTIONS.CONVERSIONS),
      wipeCollection(COLLECTIONS.GOOGLE_ADS_UPLOADS),
      wipeCollection(COLLECTIONS.OFFER_REPORTS),
    ]);
    const result: ResetDataResult = {
      clicks,
      conversions,
      google_ads_uploads: uploads,
      offer_reports: offerReports,
    };
    logger.warn('data_reset_completed', { actor, ...result });
    return result;
  },
};
