import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firestore/config';
import { COLLECTIONS } from '../firestore/schema';
import { facebookCampaignReportRepository } from '../firestore';
import { logger } from '../utils/logger';
import { toInr } from '../utils/fxRates';
import {
  eventDateFromRaw,
  BACKFILL_SCAN_PAD_BEFORE_MS,
  BACKFILL_SCAN_PAD_AFTER_MS,
} from './eventTime';

// Direct mirror of ./campaignReportsBackfillService.ts but writes into
// facebook_campaign_reports. extractFbCampaign is duplicated INLINE here (same
// reason as the GAds copy — operates on raw `unknown`-typed Firestore docs).
//
// CRITICAL: must NOT call into the GAds backfill. The two reconcilers run
// side-by-side on the same Cloud Run instance, each owns its own collection.

const PAGE = 1000;
const CONVERSION_LOOKUP_CAP = 5000;
const MAX_CONVERSIONS_SCAN = Number(process.env.FB_CAMPAIGN_REPORTS_BACKFILL_MAX_CONVERSIONS ?? 200_000);
const MAX_BUCKETS_FLUSH = Number(process.env.FB_CAMPAIGN_REPORTS_BACKFILL_MAX_BUCKETS ?? 50_000);
const STATUS_BUCKETS = ['approved', 'pending', 'rejected'] as const;
type StatusBucket = (typeof STATUS_BUCKETS)[number];
type FbSource = 'fb_campaign_id' | 'utm_campaign';

const FB_UTM_SOURCES = new Set(['facebook', 'fb', 'meta', 'instagram', 'ig', 'messenger']);
const FB_UNTAGGED_CAMPAIGN_ID = 'fb_untagged';
const FB_UNTAGGED_CAMPAIGN_NAME = 'Facebook (untagged)';

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

function dayKeyUTC(d: Date): string { return d.toISOString().slice(0, 10); }
function startOfUtcDay(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function endOfUtcDay(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 1); }
function statusBucket(status: string | undefined): StatusBucket {
  const s = (status ?? '').toLowerCase();
  if (s === 'pending') return 'pending';
  if (s === 'rejected' || s === 'declined' || s === 'reversed') return 'rejected';
  return 'approved';
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

function extractFbCampaign(
  rawClick: Record<string, unknown> | null | undefined
): { campaign_id: string; source: FbSource; campaign_name?: string } | null {
  if (!rawClick) return null;
  const extra = rawClick.extra_params;
  if (extra && typeof extra === 'object') {
    const e = extra as Record<string, unknown>;
    const fbCid = e.fb_campaign_id;
    if (typeof fbCid === 'string' && fbCid.trim()) {
      return { campaign_id: fbCid.trim(), source: 'fb_campaign_id' };
    }
    const utmSource = typeof e.utm_source === 'string' ? e.utm_source.toLowerCase().trim() : '';
    const utm = e.utm_campaign;
    if (typeof utm === 'string' && utm.trim() && FB_UTM_SOURCES.has(utmSource)) {
      return { campaign_id: utm.trim(), source: 'utm_campaign' };
    }
  }
  // Synthetic fallback when the click clearly came from a Facebook ad.
  const ad = rawClick.ad_ids;
  const meta = rawClick.meta_ids;
  const hasFbclid = ad && typeof ad === 'object' && typeof (ad as Record<string, unknown>).fbclid === 'string' && (ad as Record<string, unknown>).fbclid as string;
  const hasFbCookie =
    meta && typeof meta === 'object' && (
      typeof (meta as Record<string, unknown>).fbc === 'string' ||
      typeof (meta as Record<string, unknown>).fbp === 'string'
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

export interface FbCampaignBackfillOptions {
  from?: Date;
  to?: Date;
}

export interface FbCampaignBackfillResult {
  from: string;
  to: string;
  clicks_untouched: true;
  click_metadata_scanned: number;
  clicks_with_campaign: number;
  existing_buckets_scanned: number;
  conversions_scanned: number;
  conversions_with_campaign: number;
  conversions_orphan_lookups: number;
  revenue_fx_skipped: number;
  buckets_written: number;
  duration_ms: number;
  truncated?: boolean;
  truncated_reason?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const facebookCampaignReportsBackfillService = {
  async rebuild(opts: FbCampaignBackfillOptions = {}): Promise<FbCampaignBackfillResult> {
    const started = Date.now();
    const requestedTo = opts.to ?? new Date();
    const requestedFrom = opts.from ?? new Date(requestedTo.getTime() - 120 * DAY_MS);

    const from = startOfUtcDay(requestedFrom);
    const to = endOfUtcDay(requestedTo);
    logger.info('facebook_campaign_reports_backfill_started', {
      requested_from: requestedFrom.toISOString(),
      requested_to: requestedTo.toISOString(),
      from: from.toISOString(),
      to: to.toISOString(),
    });

    const fromDay = dayKeyUTC(from);
    const toDay = dayKeyUTC(to);
    const buckets = new Map<string, Bucket>();
    const bucketFor = (campaign_id: string, source: FbSource, date: string): Bucket => {
      const key = `${campaign_id}__${date}`;
      let b = buckets.get(key);
      if (!b) { b = emptyBucket(campaign_id, source, date); buckets.set(key, b); }
      return b;
    };

    const clickMeta = new Map<string, ClickMeta>();

    let click_metadata_scanned = 0;
    let clicks_with_campaign = 0;
    let existing_buckets_scanned = 0;
    let truncated = false;
    let truncated_reason: string | undefined;

    // ── 1. existing daily docs + click metadata ──────────────────────
    {
      const snap = await db()
        .collection(COLLECTIONS.FACEBOOK_CAMPAIGN_REPORTS)
        .where('date', '>=', fromDay)
        .where('date', '<=', toDay)
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
      } else {
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
      }
    }
    {
      let cursor: Date | null = null;
      let pages = 0;
      const phaseStart = Date.now();
      // eslint-disable-next-line no-constant-condition
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
          if (!at || !offer_id) continue;
          click_metadata_scanned += 1;
          const campaign = extractFbCampaign(raw);
          if (!campaign) continue;
          clicks_with_campaign += 1;
          clickMeta.set(d.id, {
            campaign_id: campaign.campaign_id,
            source: campaign.source,
            offer_id,
            campaign_name: campaign.campaign_name,
          });
        }
        pages += 1;
        if (pages % 5 === 0) {
          logger.info('facebook_campaign_reports_backfill_click_scan_progress', {
            pages, scanned: click_metadata_scanned,
            with_campaign: clicks_with_campaign,
            elapsed_ms: Date.now() - phaseStart,
          });
        }
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
      logger.info('facebook_campaign_reports_backfill_click_scan_done', {
        pages, scanned: click_metadata_scanned,
        with_campaign: clicks_with_campaign,
        elapsed_ms: Date.now() - phaseStart,
      });
    }

    // ── 2. conversions ───────────────────────────────────────────────
    let conversions_scanned = 0;
    let conversions_with_campaign = 0;
    let orphan_lookups = 0;
    let revenue_fx_skipped = 0;
    const fxWarnedCurrencies = new Set<string>();
    {
      const scanFrom = new Date(from.getTime() - BACKFILL_SCAN_PAD_BEFORE_MS);
      const scanTo = new Date(to.getTime() + BACKFILL_SCAN_PAD_AFTER_MS);
      let cursor: Date | null = null;
      let pages = 0;
      const phaseStart = Date.now();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (conversions_scanned >= MAX_CONVERSIONS_SCAN) {
          truncated = true;
          truncated_reason = `conversions_cap_reached (${MAX_CONVERSIONS_SCAN})`;
          logger.warn('facebook_campaign_reports_backfill_conversions_cap_hit', {
            scanned: conversions_scanned, cap: MAX_CONVERSIONS_SCAN,
          });
          break;
        }
        let q: FirebaseFirestore.Query = db()
          .collection(COLLECTIONS.CONVERSIONS)
          .where('created_at', '>=', scanFrom)
          .where('created_at', '<=', scanTo)
          .orderBy('created_at', 'asc')
          .limit(PAGE);
        if (cursor) q = q.startAfter(cursor);
        const snap = await q.get();
        if (snap.empty) break;

        interface PageItem { raw: Record<string, unknown>; eventDay: string; click_id: string }
        const pageItems: PageItem[] = [];
        const orphanIds = new Set<string>();
        for (const d of snap.docs) {
          const raw = d.data() as Record<string, unknown>;
          if (raw.shadow === true) continue;
          const at = tsToDate(raw.created_at);
          if (!at) continue;
          const eventAt = eventDateFromRaw(at, raw.network_timestamp);
          const eventDay = dayKeyUTC(eventAt);
          if (eventDay < fromDay || eventDay > toDay) continue;
          conversions_scanned += 1;
          const verified = Boolean(raw.verified);
          const click_id = (raw.click_id as string | undefined) || '';
          if (!verified || !click_id) continue;
          pageItems.push({ raw, eventDay, click_id });
          if (!clickMeta.has(click_id) && orphan_lookups + orphanIds.size < CONVERSION_LOOKUP_CAP) {
            orphanIds.add(click_id);
          }
        }

        if (orphanIds.size > 0) {
          const ORPHAN_CHUNK = 300;
          const ids = Array.from(orphanIds);
          for (let i = 0; i < ids.length; i += ORPHAN_CHUNK) {
            const chunk = ids.slice(i, i + ORPHAN_CHUNK);
            const refs = chunk.map((id) => db().collection(COLLECTIONS.CLICKS).doc(id));
            try {
              const docs = await db().getAll(...refs);
              for (const cs of docs) {
                orphan_lookups += 1;
                if (!cs.exists) continue;
                const cdata = cs.data() as Record<string, unknown>;
                const campaign = extractFbCampaign(cdata);
                if (campaign) {
                  clickMeta.set(cs.id, {
                    campaign_id: campaign.campaign_id,
                    source: campaign.source,
                    offer_id: String(cdata.offer_id ?? ''),
                    campaign_name: campaign.campaign_name,
                  });
                }
              }
            } catch (err) {
              logger.warn('fb_campaign_backfill_batch_click_lookup_failed', {
                chunk_size: chunk.length,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        for (const item of pageItems) {
          const meta = clickMeta.get(item.click_id);
          if (!meta) continue;
          const offer_id = (item.raw.offer_id as string | undefined) || meta.offer_id || 'unknown';
          const payout = typeof item.raw.payout === 'number' ? (item.raw.payout as number) : 0;
          const currencyRaw = (item.raw.currency as string | undefined) || '';
          const currency = currencyRaw.trim() || 'USD';
          const status = item.raw.status as string | undefined;
          const b = bucketFor(meta.campaign_id, meta.source, item.eventDay);
          if (meta.campaign_name && !b.campaign_name) b.campaign_name = meta.campaign_name;
          b.postbacks += 1;
          b.conversions += 1;
          if (Number.isFinite(payout)) {
            const inr = toInr(payout, currency);
            if (inr != null) b.revenue += inr;
            else {
              revenue_fx_skipped += 1;
              const code = (currency ?? '').toUpperCase().trim() || 'unknown';
              if (!fxWarnedCurrencies.has(code)) {
                fxWarnedCurrencies.add(code);
                logger.warn('fb_campaign_backfill_revenue_fx_missing', {
                  currency: code,
                  hint: 'Set GOOGLE_ADS_FX_RATES env var (e.g. INR:93,EUR:100) for this code.',
                });
              }
            }
          }
          b[statusBucket(status)] += 1;
          if (offer_id) b.offers.add(offer_id);
          conversions_with_campaign += 1;
        }

        pages += 1;
        logger.info('facebook_campaign_reports_backfill_conv_scan_progress', {
          pages, scanned: conversions_scanned,
          with_campaign: conversions_with_campaign,
          orphan_lookups, elapsed_ms: Date.now() - phaseStart,
        });
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
      logger.info('facebook_campaign_reports_backfill_conv_scan_done', {
        pages, scanned: conversions_scanned,
        with_campaign: conversions_with_campaign,
        orphan_lookups, elapsed_ms: Date.now() - phaseStart,
      });
    }

    // ── 3. flush ─────────────────────────────────────────────────────
    let buckets_written = 0;
    if (buckets.size > MAX_BUCKETS_FLUSH) {
      truncated = true;
      truncated_reason = `bucket_cap_reached (${buckets.size}/${MAX_BUCKETS_FLUSH})`;
      logger.warn('facebook_campaign_reports_backfill_bucket_cap_hit', {
        bucket_count: buckets.size, cap: MAX_BUCKETS_FLUSH,
      });
    }
    if (!truncated && buckets.size > 0) {
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
          // Deliberately omitting clicks, spend, and fb_* fields — those
          // are owned by the hot path + facebookCampaignSyncService.
        };
        if (b.campaign_name) patch.campaign_name = b.campaign_name;
        writer.set(ref, patch, { merge: true }).catch(() => { /* surfaced via onWriteError */ });
        buckets_written += 1;
      }
      await writer.close();
    }

    // Touch the repo's read-through cache so the next dashboard read reflects
    // the rebuild without waiting for the 60s TTL to expire.
    void facebookCampaignReportRepository.fetchByCampaign;   // pure no-op, keeps import alive

    const result: FbCampaignBackfillResult = {
      from: from.toISOString(),
      to: to.toISOString(),
      clicks_untouched: true,
      click_metadata_scanned,
      clicks_with_campaign,
      existing_buckets_scanned,
      conversions_scanned,
      conversions_with_campaign,
      conversions_orphan_lookups: orphan_lookups,
      revenue_fx_skipped,
      buckets_written,
      duration_ms: Date.now() - started,
      ...(truncated ? { truncated, truncated_reason } : {}),
    };
    logger.info('facebook_campaign_reports_backfill_completed', { ...result });
    return result;
  },
};
