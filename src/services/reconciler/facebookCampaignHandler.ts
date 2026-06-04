import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../../firestore/config';
import { COLLECTIONS } from '../../firestore/schema';
import { logger } from '../../utils/logger';
import { toInr } from '../../utils/fxRates';
import { eventDateFromRaw } from '../eventTime';
import {
  dayKeyUTC,
  statusBucket,
  tsToDate,
  type FlushResult,
  type PrepareResult,
  type ReconcilerHandler,
  type ReconcilerWindow,
} from './types';

// Handler for `facebook_campaign_reports`. Same shape as the GAds handler but
// reads FB-specific fields (extra_params.fb_campaign_id, fbclid, meta_ids cookies)
// and writes to a different collection.

const MAX_CONVERSIONS_SCAN = Number(process.env.FB_CAMPAIGN_REPORTS_BACKFILL_MAX_CONVERSIONS ?? 200_000);
const MAX_BUCKETS_FLUSH = Number(process.env.FB_CAMPAIGN_REPORTS_BACKFILL_MAX_BUCKETS ?? 50_000);

const FB_UNTAGGED_CAMPAIGN_ID = 'fb_untagged';
const FB_UNTAGGED_CAMPAIGN_NAME = 'Facebook (untagged)';
const FB_UTM_SOURCES = new Set(['facebook', 'fb', 'meta', 'instagram', 'ig', 'messenger', 'msg', 'an']);
// Meta campaign / ad IDs are 15-17 digit numbers — used to tell a numeric
// utm_campaign apart from a text one. See ../facebookCampaignExtractor.ts
// for the priority ladder this enables.
const META_ID_RE = /^\d{10,20}$/;

type FbSource = 'fb_campaign_id' | 'utm_id' | 'utm_campaign';

interface Bucket {
  campaign_id: string;
  source: FbSource;
  date: string;
  postbacks: number;
  conversions: number;
  unverified: number;
  revenue: number;
  approved: number;
  pending: number;
  rejected: number;
  offers: Set<string>;
  campaign_name?: string;
}

interface ClickMeta {
  campaign_id: string;
  source: FbSource;
  offer_id: string;
  campaign_name?: string;
}

function emptyBucket(campaign_id: string, source: FbSource, date: string): Bucket {
  return {
    campaign_id, source, date,
    postbacks: 0, conversions: 0, unverified: 0, revenue: 0,
    approved: 0, pending: 0, rejected: 0,
    offers: new Set<string>(),
  };
}

function extractFbCampaign(
  rawClick: Record<string, unknown> | null | undefined
): { campaign_id: string; source: FbSource; campaign_name?: string } | null {
  if (!rawClick) return null;

  const extra = rawClick.extra_params;
  const e = (extra && typeof extra === 'object') ? (extra as Record<string, unknown>) : {};

  // 1. Operator-set explicit Meta campaign id — always trusted.
  const fbCid = e.fb_campaign_id;
  if (typeof fbCid === 'string' && fbCid.trim()) {
    return { campaign_id: fbCid.trim(), source: 'fb_campaign_id' };
  }

  const utmSource = typeof e.utm_source === 'string' ? e.utm_source.toLowerCase().trim() : '';
  const utmId = typeof e.utm_id === 'string' ? e.utm_id.trim() : '';
  const utmCampaign = typeof e.utm_campaign === 'string' ? e.utm_campaign.trim() : '';
  const fromMetaUtm = utmSource !== '' && FB_UTM_SOURCES.has(utmSource);

  // 2. utm_id — Meta's canonical numeric campaign id (preferred over utm_campaign
  //    which often carries the friendly NAME, not the id).
  if (fromMetaUtm && utmId && META_ID_RE.test(utmId)) {
    return {
      campaign_id: utmId,
      source: 'utm_id',
      campaign_name: utmCampaign && !META_ID_RE.test(utmCampaign) ? utmCampaign : undefined,
    };
  }

  // 3. utm_campaign fallback. Record campaign_name when value is text so the
  //    dashboard shows a readable label until Insights sync overwrites with
  //    the canonical Meta campaign name.
  if (fromMetaUtm && utmCampaign) {
    const isNumeric = META_ID_RE.test(utmCampaign);
    return {
      campaign_id: utmCampaign,
      source: 'utm_campaign',
      campaign_name: isNumeric ? undefined : utmCampaign,
    };
  }

  // 4. Synthetic fallback — Meta-tagged click with no campaign id.
  const ad = rawClick.ad_ids;
  const meta = rawClick.meta_ids;
  const hasFbclid =
    ad && typeof ad === 'object' &&
    typeof (ad as Record<string, unknown>).fbclid === 'string' &&
    ((ad as Record<string, unknown>).fbclid as string).trim() !== '';
  const hasFbCookie =
    meta && typeof meta === 'object' && (
      (typeof (meta as Record<string, unknown>).fbc === 'string' && ((meta as Record<string, unknown>).fbc as string).trim() !== '') ||
      (typeof (meta as Record<string, unknown>).fbp === 'string' && ((meta as Record<string, unknown>).fbp as string).trim() !== '')
    );
  if (hasFbclid || hasFbCookie) {
    return {
      campaign_id: FB_UNTAGGED_CAMPAIGN_ID,
      source: 'fb_campaign_id',
      campaign_name: FB_UNTAGGED_CAMPAIGN_NAME,
    };
  }
  return null;
}

const fxWarnCache = new Set<string>();

export function createFacebookCampaignHandler(): ReconcilerHandler {
  const buckets = new Map<string, Bucket>();
  const clickMeta = new Map<string, ClickMeta>();
  let window: ReconcilerWindow | null = null;
  let existing_buckets_scanned = 0;
  let conversions_scanned = 0;
  let conversions_with_campaign = 0;
  let conversions_orphan_lookups = 0;
  let clicks_with_campaign = 0;
  let revenue_fx_skipped = 0;
  let truncated = false;
  let truncated_reason: string | undefined;
  const orphanWants = new Set<string>();
  const CONVERSION_LOOKUP_CAP = 5000;
  const started = Date.now();

  const bucketFor = (campaign_id: string, source: FbSource, date: string): Bucket => {
    const key = `${campaign_id}__${date}`;
    let b = buckets.get(key);
    if (!b) { b = emptyBucket(campaign_id, source, date); buckets.set(key, b); }
    return b;
  };

  function payoutToInr(payout: number, currency: string | undefined): number | null {
    const code = (currency ?? '').toUpperCase().trim() || 'USD';
    const inr = toInr(payout, code);
    if (inr == null) {
      revenue_fx_skipped += 1;
      const key = `fb_campaign_backfill_fx:${code}`;
      if (!fxWarnCache.has(key)) {
        fxWarnCache.add(key);
        logger.warn('fb_campaign_backfill_revenue_fx_missing', {
          currency: code,
          hint: 'Set GOOGLE_ADS_FX_RATES env var (e.g. INR:93,EUR:100) for this code.',
        });
      }
      return null;
    }
    return inr;
  }

  function applyConversionWithMeta(rawConv: Record<string, unknown>, meta: ClickMeta, eventDay: string): void {
    const offer_id = (rawConv.offer_id as string | undefined) || meta.offer_id || 'unknown';
    const payout = typeof rawConv.payout === 'number' ? rawConv.payout : 0;
    const currencyRaw = (rawConv.currency as string | undefined) || '';
    const currency = currencyRaw.trim() || 'USD';
    const status = rawConv.status as string | undefined;
    const b = bucketFor(meta.campaign_id, meta.source, eventDay);
    if (meta.campaign_name && !b.campaign_name) b.campaign_name = meta.campaign_name;
    b.postbacks += 1;
    b.conversions += 1;
    if (Number.isFinite(payout)) {
      const inr = payoutToInr(payout, currency);
      if (inr != null) b.revenue += inr;
    }
    b[statusBucket(status)] += 1;
    if (offer_id) b.offers.add(offer_id);
    conversions_with_campaign += 1;
  }

  interface DeferredConversion {
    rawConv: Record<string, unknown>;
    eventDay: string;
    click_id: string;
  }
  const deferred: DeferredConversion[] = [];

  return {
    name: 'facebook_campaign_reports',
    needsClickScan: true,

    async prepare(w: ReconcilerWindow): Promise<PrepareResult> {
      window = w;
      const snap = await db()
        .collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS)
        .where('date', '>=', w.fromDay)
        .where('date', '<=', w.toDay)
        .orderBy('date', 'asc')
        .limit(MAX_BUCKETS_FLUSH + 1)
        .get();
      existing_buckets_scanned = snap.size;
      if (snap.size > MAX_BUCKETS_FLUSH) {
        truncated = true;
        truncated_reason = `bucket_cap_reached (${snap.size}/${MAX_BUCKETS_FLUSH})`;
        logger.warn('facebook_campaign_reports_backfill_existing_bucket_cap_hit', {
          bucket_count: snap.size, cap: MAX_BUCKETS_FLUSH,
        });
        return { participates: false, existing_buckets_scanned, truncated, truncated_reason };
      }
      for (const d of snap.docs) {
        const raw = d.data() as Record<string, unknown>;
        const campaign_id = String(raw.campaign_id ?? '').trim();
        const sourceRaw = String(raw.source ?? 'fb_campaign_id');
        const source: FbSource = sourceRaw === 'utm_campaign' ? 'utm_campaign' : 'fb_campaign_id';
        const date = String(raw.date ?? '').trim();
        if (!campaign_id || !date) continue;
        const b = bucketFor(campaign_id, source, date);
        if (Array.isArray(raw.offers)) {
          for (const offer of raw.offers) {
            const id = String(offer ?? '').trim();
            if (id) b.offers.add(id);
          }
        }
      }
      return { participates: true, existing_buckets_scanned };
    },

    processClick(click_id: string, raw: Record<string, unknown>): void {
      const offer_id = String(raw.offer_id ?? '');
      if (!offer_id) return;
      const campaign = extractFbCampaign(raw);
      if (!campaign) return;
      clicks_with_campaign += 1;
      clickMeta.set(click_id, {
        campaign_id: campaign.campaign_id,
        source: campaign.source,
        offer_id,
        campaign_name: campaign.campaign_name,
      });
    },

    processConversion(_id: string, raw: Record<string, unknown>): void {
      if (!window) return;
      if (raw.shadow === true) return;
      if (conversions_scanned >= MAX_CONVERSIONS_SCAN) {
        if (!truncated) {
          truncated = true;
          truncated_reason = `conversions_cap_reached (${MAX_CONVERSIONS_SCAN})`;
          logger.warn('facebook_campaign_reports_backfill_conversions_cap_hit', {
            scanned: conversions_scanned, cap: MAX_CONVERSIONS_SCAN,
          });
        }
        return;
      }
      const at = tsToDate(raw.created_at);
      if (!at) return;
      const eventAt = eventDateFromRaw(at, raw.network_timestamp);
      const eventDay = dayKeyUTC(eventAt);
      if (eventDay < window.fromDay || eventDay > window.toDay) return;
      conversions_scanned += 1;
      const verified = Boolean(raw.verified);
      const click_id = (raw.click_id as string | undefined) || '';
      if (!verified || !click_id) return;

      const meta = clickMeta.get(click_id);
      if (meta) {
        applyConversionWithMeta(raw, meta, eventDay);
        return;
      }
      if (orphanWants.size < CONVERSION_LOOKUP_CAP) {
        orphanWants.add(click_id);
        deferred.push({ rawConv: raw, eventDay, click_id });
      }
    },

    needsOrphanLookup(click_id: string): boolean {
      return orphanWants.has(click_id);
    },

    processOrphanClick(click_id: string, raw: Record<string, unknown>): void {
      conversions_orphan_lookups += 1;
      orphanWants.delete(click_id);
      const campaign = extractFbCampaign(raw);
      if (!campaign) return;
      const meta: ClickMeta = {
        campaign_id: campaign.campaign_id,
        source: campaign.source,
        offer_id: String(raw.offer_id ?? ''),
        campaign_name: campaign.campaign_name,
      };
      clickMeta.set(click_id, meta);
      for (let i = 0; i < deferred.length; i++) {
        const d = deferred[i]!;
        if (d.click_id !== click_id) continue;
        applyConversionWithMeta(d.rawConv, meta, d.eventDay);
      }
    },

    async flush(): Promise<FlushResult> {
      if (truncated) {
        return {
          name: 'facebook_campaign_reports', ok: false,
          buckets_written: 0,
          conversions_scanned,
          conversions_with_campaign,
          conversions_orphan_lookups,
          clicks_with_campaign,
          revenue_fx_skipped,
          existing_buckets_scanned,
          truncated, truncated_reason,
          duration_ms: Date.now() - started,
        };
      }
      if (buckets.size > MAX_BUCKETS_FLUSH) {
        truncated = true;
        truncated_reason = `bucket_cap_reached (${buckets.size}/${MAX_BUCKETS_FLUSH})`;
        logger.warn('facebook_campaign_reports_backfill_bucket_cap_hit', {
          bucket_count: buckets.size, cap: MAX_BUCKETS_FLUSH,
        });
        return {
          name: 'facebook_campaign_reports', ok: false,
          buckets_written: 0,
          conversions_scanned,
          conversions_with_campaign,
          conversions_orphan_lookups,
          clicks_with_campaign,
          revenue_fx_skipped,
          existing_buckets_scanned,
          truncated, truncated_reason,
          duration_ms: Date.now() - started,
        };
      }
      let buckets_written = 0;
      if (buckets.size > 0) {
        const writer = db().bulkWriter();
        writer.onWriteError((err) => err.failedAttempts < 5);
        for (const b of buckets.values()) {
          const ref = db().collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS).doc(`${b.campaign_id}__${b.date}`);
          const patch: Record<string, unknown> = {
            campaign_id: b.campaign_id,
            source: b.source,
            date: b.date,
            postbacks: b.postbacks,
            conversions: b.conversions,
            unverified: b.unverified,
            revenue: b.revenue,
            approved: b.approved,
            pending: b.pending,
            rejected: b.rejected,
            offers: Array.from(b.offers),
            updated_at: FieldValue.serverTimestamp(),
            backfilled_at: FieldValue.serverTimestamp(),
          };
          if (b.campaign_name) patch.campaign_name = b.campaign_name;
          writer.set(ref, patch, { merge: true }).catch(() => { /* surfaced via onWriteError */ });
          buckets_written += 1;
        }
        await writer.close();
      }
      return {
        name: 'facebook_campaign_reports', ok: true,
        buckets_written,
        conversions_scanned,
        conversions_with_campaign,
        conversions_orphan_lookups,
        clicks_with_campaign,
        revenue_fx_skipped,
        existing_buckets_scanned,
        duration_ms: Date.now() - started,
      };
    },
  };
}
