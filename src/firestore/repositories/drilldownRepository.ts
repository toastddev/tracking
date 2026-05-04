import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config';
import { COLLECTIONS } from '../schema';
import type { ClickRecord, ConversionRecord } from '../../types';
import { eventDate } from '../../services/eventTime';

function dayKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function detectAdPlatform(ad_ids: Record<string, string | undefined> | undefined): string {
  if (!ad_ids) return 'organic';
  if (ad_ids.gclid || ad_ids.gbraid || ad_ids.wbraid) return 'google';
  if (ad_ids.fbclid) return 'facebook';
  if (ad_ids.ttclid) return 'tiktok';
  if (ad_ids.msclkid) return 'microsoft';
  return 'organic';
}

function statusBucket(s: string | undefined): 'approved' | 'pending' | 'rejected' {
  const v = (s ?? '').toLowerCase();
  if (v === 'pending') return 'pending';
  if (v === 'rejected' || v === 'declined' || v === 'reversed') return 'rejected';
  return 'approved';
}

const PAYOUT_EDGES = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000, Infinity];
function payoutBucketIdx(value: number): number {
  for (let i = 0; i < PAYOUT_EDGES.length - 1; i++) {
    const lo = PAYOUT_EDGES[i]!;
    const hi = PAYOUT_EDGES[i + 1]!;
    if (value >= lo && value < hi) {
      return i;
    }
  }
  return PAYOUT_EDGES.length - 2;
}

function truncateKey(k: string | undefined | null, fallback: string): string {
  if (!k) return fallback;
  const str = String(k).trim();
  if (!str) return fallback;
  // Firestore map keys cannot contain `.`, so replace them
  let safe = str.replace(/\./g, '_');
  // Truncate to avoid massive keys
  if (safe.length > 100) safe = safe.slice(0, 100);
  return safe;
}

export interface OfferDrilldownDoc {
  offer_id: string;
  date: string;
  affiliates?: Record<string, { clicks?: number; conversions?: number; revenue?: number }>;
  countries?: Record<string, { clicks?: number; conversions?: number; revenue?: number }>;
  s1?: Record<string, { clicks?: number; conversions?: number; revenue?: number }>;
  s2?: Record<string, { clicks?: number; conversions?: number; revenue?: number }>;
  ad_platforms?: Record<string, { clicks?: number; conversions?: number; revenue?: number }>;
  heatmap?: Record<string, number>;
  payout_histogram?: Record<string, { count?: number; revenue?: number }>;
  updated_at: FirebaseFirestore.Timestamp;
}

export interface PostbackDrilldownDoc {
  network_id: string;
  date: string;
  offers?: Record<string, { postbacks?: number; verified?: number; unverified?: number; approved?: number; pending?: number; rejected?: number; revenue?: number }>;
  sources?: Record<string, { postbacks?: number; verified?: number }>;
  methods?: Record<string, { postbacks?: number; verified?: number }>;
  heatmap?: Record<string, number>;
  mapping_health?: { fires_with_payout?: number; fires_with_status?: number; fires_with_txn_id?: number };
  latency?: Record<string, number>;
  updated_at: FirebaseFirestore.Timestamp;
}

export const drilldownRepository = {
  // ── Offer Drilldowns ──────────────────────────────────────────────────
  // Nested object literals (not dot-notation keys) — `set({ merge: true })` does
  // NOT split keys on dots; a key like `"heatmap.0_14"` becomes a literal top-
  // level field name that the reader never looks at. Nested objects deep-merge
  // correctly into the existing maps.
  async incrementOfferClick(click: ClickRecord): Promise<void> {
    const date = new Date(click.created_at);
    if (Number.isNaN(date.getTime())) return;

    const day = dayKeyUTC(date);
    const docId = `${click.offer_id}__${day}`;

    const aff_id = truncateKey(click.aff_id, '(none)');
    const country = truncateKey(click.country, 'unknown');
    const s1 = click.sub_params?.s1 ? truncateKey(click.sub_params.s1, '') : null;
    const s2 = click.sub_params?.s2 ? truncateKey(click.sub_params.s2, '') : null;
    const platform = detectAdPlatform(click.ad_ids);

    const dow = date.getUTCDay();
    const hour = date.getUTCHours();
    const heatmapKey = `${dow}_${hour}`;

    const update: Record<string, any> = {
      offer_id: click.offer_id,
      date: day,
      updated_at: FieldValue.serverTimestamp(),
      affiliates: { [aff_id]: { clicks: FieldValue.increment(1) } },
      countries: { [country]: { clicks: FieldValue.increment(1) } },
      ad_platforms: { [platform]: { clicks: FieldValue.increment(1) } },
      heatmap: { [heatmapKey]: FieldValue.increment(1) },
    };

    if (s1) update.s1 = { [s1]: { clicks: FieldValue.increment(1) } };
    if (s2) update.s2 = { [s2]: { clicks: FieldValue.increment(1) } };

    await db().collection(COLLECTIONS.OFFER_DRILLDOWNS).doc(docId).set(update, { merge: true });
  },

  async incrementOfferConversion(conv: ConversionRecord, click: ClickRecord | null): Promise<void> {
    if (conv.shadow) return;
    // Bucket on event-time, not receipt-time, so late API pulls don't smear
    // a May-1 conversion into May 2.
    const date = eventDate(conv);
    if (Number.isNaN(date.getTime())) return;
    const day = dayKeyUTC(date);

    const offer_id = conv.offer_id || 'unknown';
    const docId = `${offer_id}__${day}`;

    const update: Record<string, any> = {
      offer_id,
      date: day,
      updated_at: FieldValue.serverTimestamp(),
    };

    const verified = conv.verified;
    const payout = typeof conv.payout === 'number' ? conv.payout : 0;

    if (verified && click) {
      const aff_id = truncateKey(click.aff_id, '(none)');
      const country = truncateKey(click.country, 'unknown');
      const s1 = click.sub_params?.s1 ? truncateKey(click.sub_params.s1, '') : null;
      const s2 = click.sub_params?.s2 ? truncateKey(click.sub_params.s2, '') : null;
      const platform = detectAdPlatform(click.ad_ids);

      const affEntry: Record<string, unknown> = { conversions: FieldValue.increment(1) };
      const countryEntry: Record<string, unknown> = { conversions: FieldValue.increment(1) };
      const platformEntry: Record<string, unknown> = { conversions: FieldValue.increment(1) };
      const s1Entry: Record<string, unknown> | null = s1 ? { conversions: FieldValue.increment(1) } : null;
      const s2Entry: Record<string, unknown> | null = s2 ? { conversions: FieldValue.increment(1) } : null;

      if (payout > 0) {
        affEntry.revenue = FieldValue.increment(payout);
        countryEntry.revenue = FieldValue.increment(payout);
        platformEntry.revenue = FieldValue.increment(payout);
        if (s1Entry) s1Entry.revenue = FieldValue.increment(payout);
        if (s2Entry) s2Entry.revenue = FieldValue.increment(payout);
      }

      update.affiliates = { [aff_id]: affEntry };
      update.countries = { [country]: countryEntry };
      update.ad_platforms = { [platform]: platformEntry };
      if (s1 && s1Entry) update.s1 = { [s1]: s1Entry };
      if (s2 && s2Entry) update.s2 = { [s2]: s2Entry };

      if (payout > 0) {
        const pIdx = payoutBucketIdx(payout);
        update.payout_histogram = {
          [String(pIdx)]: {
            count: FieldValue.increment(1),
            revenue: FieldValue.increment(payout),
          },
        };
      }
    }

    await db().collection(COLLECTIONS.OFFER_DRILLDOWNS).doc(docId).set(update, { merge: true });
  },

  // ── Postback Drilldowns ────────────────────────────────────────────────
  async incrementPostback(conv: ConversionRecord): Promise<void> {
    if (conv.shadow) return;
    // Day key, heatmap dow/hour both reflect the event time the network
    // reported. Latency below still uses created_at vs network_timestamp
    // separately — that's the whole point of the latency metric.
    const date = eventDate(conv);
    if (Number.isNaN(date.getTime())) return;
    const day = dayKeyUTC(date);

    const network_id = conv.network_id || '(unknown)';
    const docId = `${network_id}__${day}`;

    const update: Record<string, any> = {
      network_id,
      date: day,
      updated_at: FieldValue.serverTimestamp(),
    };

    const offer_id = truncateKey(conv.offer_id, '(unattributed)');
    const src = conv.source === 'postback' || conv.source === 'api' ? conv.source : 'unknown';
    const method = conv.method === 'GET' || conv.method === 'POST' ? conv.method : 'unknown';
    const verified = conv.verified;
    const payout = typeof conv.payout === 'number' ? conv.payout : 0;
    const status = statusBucket(conv.status);

    const dow = date.getUTCDay();
    const hour = date.getUTCHours();
    const heatmapKey = `${dow}_${hour}`;

    const offerEntry: Record<string, unknown> = { postbacks: FieldValue.increment(1) };
    const sourceEntry: Record<string, unknown> = { postbacks: FieldValue.increment(1) };

    if (verified) {
      offerEntry.verified = FieldValue.increment(1);
      offerEntry[status] = FieldValue.increment(1);
      if (payout > 0) offerEntry.revenue = FieldValue.increment(payout);
      sourceEntry.verified = FieldValue.increment(1);
    } else {
      offerEntry.unverified = FieldValue.increment(1);
    }

    update.offers = { [offer_id]: offerEntry };
    update.sources = { [src]: sourceEntry };
    update.heatmap = { [heatmapKey]: FieldValue.increment(1) };

    if (method !== 'unknown') {
      const methodEntry: Record<string, unknown> = { postbacks: FieldValue.increment(1) };
      if (verified) methodEntry.verified = FieldValue.increment(1);
      update.methods = { [method]: methodEntry };
    }

    const mappingHealth: Record<string, unknown> = {};
    if (typeof conv.payout === 'number') mappingHealth.fires_with_payout = FieldValue.increment(1);
    if (conv.status) mappingHealth.fires_with_status = FieldValue.increment(1);
    if (conv.txn_id) mappingHealth.fires_with_txn_id = FieldValue.increment(1);
    if (Object.keys(mappingHealth).length > 0) update.mapping_health = mappingHealth;

    if (verified && conv.network_timestamp) {
      // Latency is fundamentally (receipt - event), so it must use the raw
      // `created_at` here, NOT the event-bucketed `date` above.
      const networkAt = new Date(conv.network_timestamp).getTime();
      const receivedAt = new Date(conv.created_at).getTime();
      if (Number.isFinite(networkAt) && Number.isFinite(receivedAt) && receivedAt >= networkAt) {
        const latencyMins = (receivedAt - networkAt) / 60_000;
        let bucket = '60+';
        if (latencyMins <= 1) bucket = '0-1m';
        else if (latencyMins <= 5) bucket = '1-5m';
        else if (latencyMins <= 10) bucket = '5-10m';
        else if (latencyMins <= 30) bucket = '10-30m';
        else if (latencyMins <= 60) bucket = '30-60m';
        update.latency = { [bucket]: FieldValue.increment(1) };
      }
    }

    await db().collection(COLLECTIONS.POSTBACK_DRILLDOWNS).doc(docId).set(update, { merge: true });
  },

  async fetchOfferDrilldowns(offer_id: string, from: Date, to: Date): Promise<OfferDrilldownDoc[]> {
    const fromStr = dayKeyUTC(from);
    const toStr = dayKeyUTC(to);
    const snap = await db()
      .collection(COLLECTIONS.OFFER_DRILLDOWNS)
      .where('offer_id', '==', offer_id)
      .where('date', '>=', fromStr)
      .where('date', '<=', toStr)
      .get();
    return snap.docs.map(d => d.data() as OfferDrilldownDoc);
  },

  async fetchPostbackDrilldowns(network_id: string, from: Date, to: Date): Promise<PostbackDrilldownDoc[]> {
    const fromStr = dayKeyUTC(from);
    const toStr = dayKeyUTC(to);
    const snap = await db()
      .collection(COLLECTIONS.POSTBACK_DRILLDOWNS)
      .where('network_id', '==', network_id)
      .where('date', '>=', fromStr)
      .where('date', '<=', toStr)
      .get();
    return snap.docs.map(d => d.data() as PostbackDrilldownDoc);
  }
};
