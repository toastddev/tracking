import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firestore/config';
import { COLLECTIONS } from '../firestore/schema';
import { logger } from '../utils/logger';
import { drilldownRepository } from '../firestore/repositories/drilldownRepository';
import type { ClickRecord, ConversionRecord } from '../types';

const PAGE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  let safe = str.replace(/\./g, '_');
  if (safe.length > 100) safe = safe.slice(0, 100);
  return safe;
}

function tsToDate(v: unknown): Date | null {
  if (v && typeof v === 'object' && 'toDate' in (v as object)) {
    try { return (v as { toDate: () => Date }).toDate(); } catch { return null; }
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export interface DrilldownBackfillOptions {
  from?: Date;
  to?: Date;
}

export interface DrilldownBackfillResult {
  from: string;
  to: string;
  clicks_scanned: number;
  conversions_scanned: number;
  offer_docs_written: number;
  postback_docs_written: number;
  duration_ms: number;
}

function incrementMap(map: Record<string, number>, key: string, val: number) {
  map[key] = (map[key] || 0) + val;
}
function incrementSubMap(map: Record<string, Record<string, number>>, key1: string, key2: string, val: number) {
  if (!map[key1]) map[key1] = {};
  map[key1]![key2] = (map[key1]![key2] || 0) + val;
}

export const drilldownsBackfillService = {
  async rebuild(opts: DrilldownBackfillOptions = {}): Promise<DrilldownBackfillResult> {
    const started = Date.now();
    const to = opts.to ?? new Date();
    const from = opts.from ?? new Date(to.getTime() - 120 * DAY_MS);
    logger.info('drilldowns_backfill_started', { from: from.toISOString(), to: to.toISOString() });

    const offerBuckets = new Map<string, any>();
    const postbackBuckets = new Map<string, any>();

    const getOfferBucket = (offer_id: string, date: string) => {
      const docId = `${offer_id}__${date}`;
      let b = offerBuckets.get(docId);
      if (!b) {
        b = { offer_id, date, affiliates: {}, countries: {}, s1: {}, s2: {}, ad_platforms: {}, heatmap: {}, payout_histogram: {} };
        offerBuckets.set(docId, b);
      }
      return b;
    };

    const getPostbackBucket = (network_id: string, date: string) => {
      const docId = `${network_id}__${date}`;
      let b = postbackBuckets.get(docId);
      if (!b) {
        b = { network_id, date, offers: {}, sources: {}, methods: {}, heatmap: {}, mapping_health: { fires_with_payout: 0, fires_with_status: 0, fires_with_txn_id: 0 }, latency: {} };
        postbackBuckets.set(docId, b);
      }
      return b;
    };

    // We need click info to attribute conversions correctly, so we must load clicks into memory.
    // If the date range is 120 days, there could be 1M+ clicks. To avoid OOM, we store only minimal data.
    const clickMap = new Map<string, { aff_id: string; country: string; s1: string | null; s2: string | null; platform: string }>();

    let clicks_scanned = 0;
    {
      let cursor: Date | null = null;
      while (true) {
        let q: FirebaseFirestore.Query = db()
          .collection(COLLECTIONS.CLICKS)
          .where('created_at', '>=', from)
          .where('created_at', '<=', to)
          .orderBy('created_at', 'asc')
          .limit(PAGE);
        if (cursor) q = q.startAfter(cursor);
        const snap = await q.get();
        if (snap.empty) break;
        for (const d of snap.docs) {
          const raw = d.data() as Record<string, unknown>;
          const at = tsToDate(raw.created_at);
          const offer_id = String(raw.offer_id ?? '');
          const click_id = String(raw.click_id ?? d.id);
          if (!at || !offer_id) continue;

          const aff_id = truncateKey(raw.aff_id as string, '(none)');
          const country = truncateKey(raw.country as string, 'unknown');
          const sub = raw.sub_params as Record<string, string> | undefined;
          const s1 = sub?.s1 ? truncateKey(sub.s1, '') : null;
          const s2 = sub?.s2 ? truncateKey(sub.s2, '') : null;
          const platform = detectAdPlatform(raw.ad_ids as Record<string, string>);

          clickMap.set(click_id, { aff_id, country, s1, s2, platform });

          const b = getOfferBucket(offer_id, dayKeyUTC(at));
          incrementSubMap(b.affiliates, aff_id, 'clicks', 1);
          incrementSubMap(b.countries, country, 'clicks', 1);
          incrementSubMap(b.ad_platforms, platform, 'clicks', 1);
          if (s1) incrementSubMap(b.s1, s1, 'clicks', 1);
          if (s2) incrementSubMap(b.s2, s2, 'clicks', 1);

          const dow = at.getUTCDay();
          const hour = at.getUTCHours();
          incrementMap(b.heatmap, `${dow}_${hour}`, 1);

          clicks_scanned += 1;
        }
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
    }

    let conversions_scanned = 0;
    {
      let cursor: Date | null = null;
      while (true) {
        let q: FirebaseFirestore.Query = db()
          .collection(COLLECTIONS.CONVERSIONS)
          .where('created_at', '>=', from)
          .where('created_at', '<=', to)
          .orderBy('created_at', 'asc')
          .limit(PAGE);
        if (cursor) q = q.startAfter(cursor);
        const snap = await q.get();
        if (snap.empty) break;
        for (const d of snap.docs) {
          const raw = d.data() as Record<string, unknown>;
          if (raw.shadow === true) continue;
          const at = tsToDate(raw.created_at);
          if (!at) continue;

          const click_id = String(raw.click_id ?? '');
          const offer_id = (raw.offer_id as string | undefined) || 'unknown';
          const network_id = (raw.network_id as string | undefined) || '(unknown)';
          const verified = Boolean(raw.verified);
          const payout = typeof raw.payout === 'number' ? raw.payout : 0;
          const status = raw.status as string | undefined;

          // Process Offer Drilldown for Conversion
          const ob = getOfferBucket(offer_id, dayKeyUTC(at));
          if (verified) {
            const click = clickMap.get(click_id);
            if (click) {
              incrementSubMap(ob.affiliates, click.aff_id, 'conversions', 1);
              incrementSubMap(ob.countries, click.country, 'conversions', 1);
              incrementSubMap(ob.ad_platforms, click.platform, 'conversions', 1);
              if (click.s1) incrementSubMap(ob.s1, click.s1, 'conversions', 1);
              if (click.s2) incrementSubMap(ob.s2, click.s2, 'conversions', 1);

              if (payout > 0) {
                incrementSubMap(ob.affiliates, click.aff_id, 'revenue', payout);
                incrementSubMap(ob.countries, click.country, 'revenue', payout);
                incrementSubMap(ob.ad_platforms, click.platform, 'revenue', payout);
                if (click.s1) incrementSubMap(ob.s1, click.s1, 'revenue', payout);
                if (click.s2) incrementSubMap(ob.s2, click.s2, 'revenue', payout);

                const pIdx = payoutBucketIdx(payout);
                incrementSubMap(ob.payout_histogram, String(pIdx), 'count', 1);
                incrementSubMap(ob.payout_histogram, String(pIdx), 'revenue', payout);
              }
            }
          }

          // Process Postback Drilldown
          const pb = getPostbackBucket(network_id, dayKeyUTC(at));
          const srcRaw = raw.source as string | undefined;
          const src = srcRaw === 'postback' || srcRaw === 'api' ? srcRaw : 'unknown';
          const methRaw = raw.method as string | undefined;
          const method = methRaw === 'GET' || methRaw === 'POST' ? methRaw : 'unknown';
          const sBucket = statusBucket(status);

          const truncatedOfferId = truncateKey(raw.offer_id as string, '(unattributed)');

          incrementSubMap(pb.offers, truncatedOfferId, 'postbacks', 1);
          incrementSubMap(pb.sources, src, 'postbacks', 1);
          if (method !== 'unknown') incrementSubMap(pb.methods, method, 'postbacks', 1);

          const dow = at.getUTCDay();
          const hour = at.getUTCHours();
          incrementMap(pb.heatmap, `${dow}_${hour}`, 1);

          if (verified) {
            incrementSubMap(pb.offers, truncatedOfferId, 'verified', 1);
            incrementSubMap(pb.offers, truncatedOfferId, sBucket, 1);
            if (payout > 0) incrementSubMap(pb.offers, truncatedOfferId, 'revenue', payout);
            incrementSubMap(pb.sources, src, 'verified', 1);
            if (method !== 'unknown') incrementSubMap(pb.methods, method, 'verified', 1);
          } else {
            incrementSubMap(pb.offers, truncatedOfferId, 'unverified', 1);
          }

          if (typeof raw.payout === 'number') pb.mapping_health.fires_with_payout += 1;
          if (raw.status) pb.mapping_health.fires_with_status += 1;
          if (raw.txn_id) pb.mapping_health.fires_with_txn_id += 1;

          if (verified && raw.network_timestamp) {
            const networkAt = new Date(raw.network_timestamp as string).getTime();
            const receivedAt = at.getTime();
            if (Number.isFinite(networkAt) && Number.isFinite(receivedAt) && receivedAt >= networkAt) {
              const latencyMins = (receivedAt - networkAt) / 60_000;
              let bucket = '60+';
              if (latencyMins <= 1) bucket = '0-1m';
              else if (latencyMins <= 5) bucket = '1-5m';
              else if (latencyMins <= 10) bucket = '5-10m';
              else if (latencyMins <= 30) bucket = '10-30m';
              else if (latencyMins <= 60) bucket = '30-60m';
              incrementMap(pb.latency, bucket, 1);
            }
          }

          conversions_scanned += 1;
        }
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
    }

    // Free memory
    clickMap.clear();

    let offer_docs_written = 0;
    let postback_docs_written = 0;

    const writer = db().bulkWriter();
    writer.onWriteError((err) => err.failedAttempts < 5);

    for (const [docId, b] of offerBuckets.entries()) {
      const ref = db().collection(COLLECTIONS.OFFER_DRILLDOWNS).doc(docId);
      writer.set(ref, {
        ...b,
        updated_at: FieldValue.serverTimestamp(),
        backfilled_at: FieldValue.serverTimestamp(),
      }).catch(() => { /* handled */ });
      offer_docs_written += 1;
    }

    for (const [docId, b] of postbackBuckets.entries()) {
      const ref = db().collection(COLLECTIONS.POSTBACK_DRILLDOWNS).doc(docId);
      writer.set(ref, {
        ...b,
        updated_at: FieldValue.serverTimestamp(),
        backfilled_at: FieldValue.serverTimestamp(),
      }).catch(() => { /* handled */ });
      postback_docs_written += 1;
    }

    await writer.close();

    const result: DrilldownBackfillResult = {
      from: from.toISOString(),
      to: to.toISOString(),
      clicks_scanned,
      conversions_scanned,
      offer_docs_written,
      postback_docs_written,
      duration_ms: Date.now() - started,
    };
    logger.info('drilldowns_backfill_completed', { ...result });
    return result;
  },
};
