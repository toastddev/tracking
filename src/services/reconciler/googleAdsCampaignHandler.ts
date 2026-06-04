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

// Handler for `campaign_reports` (Google Ads side). Implements the
// extract-then-bucket logic that previously lived in campaignReportsBackfillService.ts.

const MAX_CONVERSIONS_SCAN = Number(process.env.CAMPAIGN_REPORTS_BACKFILL_MAX_CONVERSIONS ?? 200_000);
const MAX_BUCKETS_FLUSH = Number(process.env.CAMPAIGN_REPORTS_BACKFILL_MAX_BUCKETS ?? 50_000);

const GADS_UNTAGGED_CAMPAIGN_ID = 'gads_untagged';
const GADS_UNTAGGED_CAMPAIGN_NAME = 'GAds (untagged)';

// Only `gad_campaignid` is emitted now — utm_* is never claimed as Google. The
// stored docs may still carry `source: 'utm_campaign'` from legacy hot-path
// writes (those will be aged out as the reconciler overwrites buckets), so the
// type stays a union for back-compat reads in prepare(); writes only ever set
// 'gad_campaignid'.
type CampaignSource = 'gad_campaignid' | 'utm_campaign';

interface Bucket {
  campaign_id: string;
  source: CampaignSource;
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
  source: CampaignSource;
  offer_id: string;
  campaign_name?: string;
}

function emptyBucket(campaign_id: string, source: CampaignSource, date: string): Bucket {
  return {
    campaign_id, source, date,
    postbacks: 0, conversions: 0, unverified: 0, revenue: 0,
    approved: 0, pending: 0, rejected: 0,
    offers: new Set<string>(),
  };
}

// Mirror of clickService.extractCampaign for the reconciler. Strict — only
// `gad_campaignid` or a Google click identifier (gclid/gbraid/wbraid) qualifies.
// utm_campaign is intentionally NOT a fallback (it leaked FB/other traffic into
// the GAds rollup). Raw-doc tolerant.
export function extractCampaign(
  rawClick: Record<string, unknown> | null | undefined
): { campaign_id: string; source: CampaignSource; campaign_name?: string } | null {
  if (!rawClick) return null;
  const extra = rawClick.extra_params;
  if (extra && typeof extra === 'object') {
    const e = extra as Record<string, unknown>;
    const gad = e.gad_campaignid;
    if (typeof gad === 'string' && gad.trim()) {
      return { campaign_id: gad.trim(), source: 'gad_campaignid' };
    }
  }
  const ad = rawClick.ad_ids;
  if (ad && typeof ad === 'object') {
    const a = ad as Record<string, unknown>;
    if (
      (typeof a.gclid === 'string' && a.gclid.trim()) ||
      (typeof a.gbraid === 'string' && a.gbraid.trim()) ||
      (typeof a.wbraid === 'string' && a.wbraid.trim())
    ) {
      return {
        campaign_id: GADS_UNTAGGED_CAMPAIGN_ID,
        source: 'gad_campaignid',
        campaign_name: GADS_UNTAGGED_CAMPAIGN_NAME,
      };
    }
  }
  return null;
}

const fxWarnCache = new Set<string>();

export function createGoogleAdsCampaignHandler(): ReconcilerHandler {
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
  // click_ids the conversions pass saw but couldn't resolve locally — needed
  // for orphan batched fetch.
  const orphanWants = new Set<string>();
  const CONVERSION_LOOKUP_CAP = 5000;
  const started = Date.now();

  const bucketFor = (campaign_id: string, source: CampaignSource, date: string): Bucket => {
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
      const key = `gads_campaign_backfill_fx:${code}`;
      if (!fxWarnCache.has(key)) {
        fxWarnCache.add(key);
        logger.warn('campaign_backfill_revenue_fx_missing', {
          currency: code,
          hint: 'Set GOOGLE_ADS_FX_RATES env var (e.g. INR:93,EUR:100) for this code.',
        });
      }
      return null;
    }
    return inr;
  }

  // Apply a resolved click to a deferred conversion. Used both inline (when
  // the click was in the main scan window) and from processOrphanClick.
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

  // Conversions whose click resolution is pending the orphan lookup.
  // Re-applied when processOrphanClick runs.
  interface DeferredConversion {
    rawConv: Record<string, unknown>;
    eventDay: string;
    click_id: string;
  }
  const deferred: DeferredConversion[] = [];

  return {
    name: 'campaign_reports',
    needsClickScan: true,

    async prepare(w: ReconcilerWindow): Promise<PrepareResult> {
      window = w;
      const snap = await db()
        .collection(COLLECTIONS.CAMPAIGN_REPORTS)
        .where('date', '>=', w.fromDay)
        .where('date', '<=', w.toDay)
        .orderBy('date', 'asc')
        .limit(MAX_BUCKETS_FLUSH + 1)
        .get();
      existing_buckets_scanned = snap.size;
      if (snap.size > MAX_BUCKETS_FLUSH) {
        truncated = true;
        truncated_reason = `bucket_cap_reached (${snap.size}/${MAX_BUCKETS_FLUSH})`;
        logger.warn('campaign_reports_backfill_existing_bucket_cap_hit', {
          bucket_count: snap.size, cap: MAX_BUCKETS_FLUSH,
        });
        return { participates: false, existing_buckets_scanned, truncated, truncated_reason };
      }
      for (const d of snap.docs) {
        const raw = d.data() as Record<string, unknown>;
        const campaign_id = String(raw.campaign_id ?? '').trim();
        const sourceRaw = String(raw.source ?? 'gad_campaignid');
        const source: CampaignSource = sourceRaw === 'utm_campaign' ? 'utm_campaign' : 'gad_campaignid';
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
      const campaign = extractCampaign(raw);
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
          logger.warn('campaign_reports_backfill_conversions_cap_hit', {
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
      // Cap orphan requests so a wild dataset can't blow up read costs.
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
      const campaign = extractCampaign(raw);
      if (!campaign) return;
      const meta: ClickMeta = {
        campaign_id: campaign.campaign_id,
        source: campaign.source,
        offer_id: String(raw.offer_id ?? ''),
        campaign_name: campaign.campaign_name,
      };
      clickMeta.set(click_id, meta);
      // Replay any deferred conversion for this click_id (could be more than
      // one if the same click produced multiple postbacks).
      for (let i = 0; i < deferred.length; i++) {
        const d = deferred[i]!;
        if (d.click_id !== click_id) continue;
        applyConversionWithMeta(d.rawConv, meta, d.eventDay);
      }
    },

    async flush(): Promise<FlushResult> {
      if (truncated) {
        return {
          name: 'campaign_reports', ok: false,
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
        logger.warn('campaign_reports_backfill_bucket_cap_hit', {
          bucket_count: buckets.size, cap: MAX_BUCKETS_FLUSH,
        });
        return {
          name: 'campaign_reports', ok: false,
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
          const ref = db().collection(COLLECTIONS.CAMPAIGN_REPORTS).doc(`${b.campaign_id}__${b.date}`);
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
            // Deliberately omitting `clicks`, `spend`, and all `gads_*` fields
            // — clicks owned by hot path, spend by user/sync, gads_* by sync.
          };
          if (b.campaign_name) patch.campaign_name = b.campaign_name;
          writer.set(ref, patch, { merge: true }).catch(() => { /* surfaced via onWriteError */ });
          buckets_written += 1;
        }
        await writer.close();
      }
      return {
        name: 'campaign_reports', ok: true,
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
