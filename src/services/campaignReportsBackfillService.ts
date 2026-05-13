import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firestore/config';
import { COLLECTIONS } from '../firestore/schema';
import { campaignReportRepository } from '../firestore';
import { logger } from '../utils/logger';
import { toInr } from '../utils/fxRates';
import {
  eventDateFromRaw,
  BACKFILL_SCAN_PAD_BEFORE_MS,
  BACKFILL_SCAN_PAD_AFTER_MS,
} from './eventTime';

// Reconstructs conversion-side fields in campaign_reports from source
// conversions. Click counts are intentionally not recalculated here: they are
// only incremented from the /click redirect path. The merge intentionally
// omits click counts, operator-entered `spend`, and `campaign_name`.
//
// Scope: all UTC days touched by [from, to]. The default window is the last
// 120 days (covers the 90-day TTL ceiling with a buffer).
//
// Click -> campaign mapping: every click carries its own extra_params, so the
// metadata pass is direct. Conversions only carry click_id; we resolve their
// campaign by looking the click up in the in-memory map first, then falling
// back to a single Firestore read per miss (capped — see CONVERSION_LOOKUP_CAP).
//
// Concurrency: live writes via postbackService/API sync also touch the
// conversion fields. Running this during low-traffic windows is recommended:
// a conversion that lands while the backfill is computing may be overwritten
// until the next reconciliation tick.

const PAGE = 1000;
const CONVERSION_LOOKUP_CAP = 5000;
const MAX_CONVERSIONS_SCAN = Number(process.env.CAMPAIGN_REPORTS_BACKFILL_MAX_CONVERSIONS ?? 200_000);
const MAX_BUCKETS_FLUSH = Number(process.env.CAMPAIGN_REPORTS_BACKFILL_MAX_BUCKETS ?? 50_000);
const STATUS_BUCKETS = ['approved', 'pending', 'rejected'] as const;
type StatusBucket = (typeof STATUS_BUCKETS)[number];
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
}

interface ClickMeta {
  campaign_id: string;
  source: CampaignSource;
  offer_id: string;
}

function emptyBucket(campaign_id: string, source: CampaignSource, date: string): Bucket {
  return {
    campaign_id,
    source,
    date,
    postbacks: 0,
    conversions: 0,
    unverified: 0,
    revenue: 0,
    approved: 0,
    pending: 0,
    rejected: 0,
    offers: new Set<string>(),
  };
}

function dayKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 1);
}

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

// Single shared rule for picking a campaign tag off a click's extra_params.
// gad_campaignid wins; utm_campaign is the cross-platform fallback.
function extractCampaign(
  extra: unknown
): { campaign_id: string; source: CampaignSource } | null {
  if (!extra || typeof extra !== 'object') return null;
  const e = extra as Record<string, unknown>;
  const gad = e.gad_campaignid;
  if (typeof gad === 'string' && gad.trim()) {
    return { campaign_id: gad.trim(), source: 'gad_campaignid' };
  }
  const utm = e.utm_campaign;
  if (typeof utm === 'string' && utm.trim()) {
    return { campaign_id: utm.trim(), source: 'utm_campaign' };
  }
  return null;
}

export interface CampaignBackfillOptions {
  from?: Date;
  to?: Date;
}

export interface CampaignBackfillResult {
  from: string;
  to: string;
  clicks_scanned: number;
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
  campaign_spends?: Array<{
    campaign_id: string;
    campaign_name: string;
    total_spend: number;
  }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const campaignReportsBackfillService = {
  async rebuild(opts: CampaignBackfillOptions = {}): Promise<CampaignBackfillResult> {
    const started = Date.now();
    const requestedTo = opts.to ?? new Date();
    const requestedFrom = opts.from ?? new Date(requestedTo.getTime() - 120 * DAY_MS);

    // Campaign docs are daily rollups. Rebuild whole UTC days so a short
    // reconciliation window cannot overwrite conversion fields with only a
    // partial-day view.
    const from = startOfUtcDay(requestedFrom);
    const to = endOfUtcDay(requestedTo);
    logger.info('campaign_reports_backfill_started', {
      requested_from: requestedFrom.toISOString(),
      requested_to: requestedTo.toISOString(),
      from: from.toISOString(),
      to: to.toISOString(),
    });

    const fromDay = dayKeyUTC(from);
    const toDay = dayKeyUTC(to);
    const buckets = new Map<string, Bucket>();
    const bucketFor = (campaign_id: string, source: CampaignSource, date: string): Bucket => {
      const key = `${campaign_id}__${date}`;
      let b = buckets.get(key);
      if (!b) { b = emptyBucket(campaign_id, source, date); buckets.set(key, b); }
      return b;
    };

    // click_id → { campaign_id, source, offer_id } so the conversions pass
    // can attribute payouts without re-reading the click. Memory cost is
    // ~100 bytes/click → 100 MB at 1M clicks, which is well within the
    // backend's envelope. For larger windows we'd shard, but 120 days at
    // current scale is fine.
    const clickMeta = new Map<string, ClickMeta>();

    // ── 1. existing daily docs + click metadata ──────────────────────
    // Existing docs seed zeroed conversion buckets while preserving click
    // counts and manually-entered spend. The click scan below only builds
    // click_id -> campaign metadata for conversion attribution; it never
    // increments or rewrites click counters.
    const clicks_scanned = 0;
    let click_metadata_scanned = 0;
    let clicks_with_campaign = 0;
    let existing_buckets_scanned = 0;
    let truncated = false;
    let truncated_reason: string | undefined;
    {
      const snap = await db()
        .collection(COLLECTIONS.CAMPAIGN_REPORTS)
        .where('date', '>=', fromDay)
        .where('date', '<=', toDay)
        .orderBy('date', 'asc')
        .limit(MAX_BUCKETS_FLUSH + 1)
        .get();
      existing_buckets_scanned = snap.size;
      if (snap.size > MAX_BUCKETS_FLUSH) {
        truncated = true;
        truncated_reason = `bucket_cap_reached (${snap.size}/${MAX_BUCKETS_FLUSH})`;
        logger.warn('campaign_reports_backfill_existing_bucket_cap_hit', {
          bucket_count: snap.size,
          cap: MAX_BUCKETS_FLUSH,
        });
      } else {
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
              const offerId = String(offer ?? '').trim();
              if (offerId) b.offers.add(offerId);
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
          const campaign = extractCampaign(raw.extra_params);
          if (!campaign) continue;
          clicks_with_campaign += 1;
          // Remember for the conversions pass.
          clickMeta.set(d.id, {
            campaign_id: campaign.campaign_id,
            source: campaign.source,
            offer_id,
          });
        }
        pages += 1;
        // Heartbeat every ~5k clicks so a long scan is visibly progressing
        // (was silent before — easily mistaken for a hang on big windows).
        if (pages % 5 === 0) {
          logger.info('campaign_reports_backfill_click_scan_progress', {
            pages,
            scanned: click_metadata_scanned,
            with_campaign: clicks_with_campaign,
            elapsed_ms: Date.now() - phaseStart,
          });
        }
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
      logger.info('campaign_reports_backfill_click_scan_done', {
        pages,
        scanned: click_metadata_scanned,
        with_campaign: clicks_with_campaign,
        elapsed_ms: Date.now() - phaseStart,
      });
    }

    // ── 2. conversions ───────────────────────────────────────────────
    // For each conversion, we need the click's extra_params. Fast path: the
    // in-memory map. Slow path: read the click doc, capped at
    // CONVERSION_LOOKUP_CAP misses to bound runtime on huge datasets.
    //
    // Orphan lookups are BATCHED per page via Firestore getAll. Before this,
    // each miss cost a sequential round-trip (50-200ms × up to 5000 = many
    // minutes of silence — easily mistaken for a hang).
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
          logger.warn('campaign_reports_backfill_conversions_cap_hit', {
            scanned: conversions_scanned,
            cap: MAX_CONVERSIONS_SCAN,
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

        // Pass 1 — filter & collect orphan click_ids for batched fetch.
        interface PageItem {
          raw: Record<string, unknown>;
          eventDay: string;
          click_id: string;
        }
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

        // Batched orphan lookup. getAll handles arbitrary fan-out under the
        // hood, but chunk at 300 to bound latency on a single round-trip and
        // surface a heartbeat between chunks.
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
                const campaign = extractCampaign(cdata.extra_params);
                if (campaign) {
                  clickMeta.set(cs.id, {
                    campaign_id: campaign.campaign_id,
                    source: campaign.source,
                    offer_id: String(cdata.offer_id ?? ''),
                  });
                }
              }
            } catch (err) {
              logger.warn('campaign_backfill_batch_click_lookup_failed', {
                chunk_size: chunk.length,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        // Pass 2 — attribute now that all click metadata for this page is in
        // the cache.
        for (const item of pageItems) {
          const meta = clickMeta.get(item.click_id);
          if (!meta) continue;
          const offer_id = (item.raw.offer_id as string | undefined) || meta.offer_id || 'unknown';
          const payout = typeof item.raw.payout === 'number' ? (item.raw.payout as number) : 0;
          // Empty / missing currency on a conversion means the postback /
          // affiliate API didn't tag the row. By system convention raw payouts
          // are USD (offer_reports store them raw, in USD), so default to USD
          // when nothing else is set — otherwise toInr short-circuits and the
          // raw USD figure ends up sitting in the INR-denominated revenue
          // field, which is exactly the regression we just hit.
          const currencyRaw = (item.raw.currency as string | undefined) || '';
          const currency = currencyRaw.trim() || 'USD';
          const status = item.raw.status as string | undefined;
          const b = bucketFor(meta.campaign_id, meta.source, item.eventDay);
          b.postbacks += 1;
          b.conversions += 1;
          // Campaign revenue is canonically INR. Historical conversions may be
          // stored in USD/EUR/etc., so convert via fxRates here. Missing-rate
          // currencies are dropped (counted but not summed) so we don't
          // mislabel raw USD as INR — `revenue_fx_skipped` surfaces in logs
          // and on the result so the operator can fix the env var.
          if (Number.isFinite(payout)) {
            const inr = toInr(payout, currency);
            if (inr != null) {
              b.revenue += inr;
            } else {
              revenue_fx_skipped += 1;
              const code = (currency ?? '').toUpperCase().trim() || 'unknown';
              if (!fxWarnedCurrencies.has(code)) {
                fxWarnedCurrencies.add(code);
                logger.warn('campaign_backfill_revenue_fx_missing', {
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
        // Heartbeat every page — was every 5 before, but orphan lookups can
        // make a single page take seconds, so a per-page log keeps the
        // operator from thinking the run hung.
        logger.info('campaign_reports_backfill_conv_scan_progress', {
          pages,
          scanned: conversions_scanned,
          with_campaign: conversions_with_campaign,
          orphan_lookups,
          elapsed_ms: Date.now() - phaseStart,
        });
        const last = snap.docs[snap.docs.length - 1]!;
        cursor = tsToDate((last.data() as Record<string, unknown>).created_at);
        if (snap.size < PAGE || !cursor) break;
      }
      logger.info('campaign_reports_backfill_conv_scan_done', {
        pages,
        scanned: conversions_scanned,
        with_campaign: conversions_with_campaign,
        orphan_lookups,
        elapsed_ms: Date.now() - phaseStart,
      });
    }

    // ── 3. flush ─────────────────────────────────────────────────────
    // Merge-write conversion fields only so click counters, operator-entered
    // spend, and campaign names survive a rebuild.
    let buckets_written = 0;
    if (buckets.size > MAX_BUCKETS_FLUSH) {
      truncated = true;
      truncated_reason = `bucket_cap_reached (${buckets.size}/${MAX_BUCKETS_FLUSH})`;
      logger.warn('campaign_reports_backfill_bucket_cap_hit', {
        bucket_count: buckets.size,
        cap: MAX_BUCKETS_FLUSH,
      });
    }
    if (!truncated && buckets.size > 0) {
      const writer = db().bulkWriter();
      writer.onWriteError((err) => err.failedAttempts < 5);
      for (const b of buckets.values()) {
        const ref = db().collection(COLLECTIONS.CAMPAIGN_REPORTS).doc(`${b.campaign_id}__${b.date}`);
        writer.set(ref, {
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
          // NOTE: deliberately omitting `clicks`, `spend`, `campaign_name`,
          // and all `gads_*` fields — the merge keeps the canonical values
          // (Google Ads sync owns the gads_* fields and the spend/name fields
          // are user/api-managed).
        }, { merge: true }).catch(() => { /* surfaced via onWriteError */ });
        buckets_written += 1;
      }
      await writer.close();
    }

    const updatedCampaignIds = Array.from(new Set(Array.from(buckets.values()).map(b => b.campaign_id)));
    let campaign_spends: CampaignBackfillResult['campaign_spends'];
    if (updatedCampaignIds.length > 0) {
      try {
        const rows = await campaignReportRepository.fetchRange({
          from,
          to,
          campaign_ids: updatedCampaignIds,
        });
        const byCampaign = new Map<string, { name: string; spend: number }>();
        for (const r of rows) {
          const entry = byCampaign.get(r.campaign_id) || { name: r.campaign_id, spend: 0 };
          if (r.campaign_name) entry.name = r.campaign_name;
          entry.spend += r.spend;
          byCampaign.set(r.campaign_id, entry);
        }
        campaign_spends = updatedCampaignIds.map((id) => ({
          campaign_id: id,
          campaign_name: byCampaign.get(id)?.name || id,
          total_spend: byCampaign.get(id)?.spend || 0,
        }));
      } catch (e) {
        logger.warn('campaign_backfill_failed_to_fetch_spends', { error: String(e) });
      }
    }

    const result: CampaignBackfillResult = {
      from: from.toISOString(),
      to: to.toISOString(),
      clicks_scanned,
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
      campaign_spends,
    };
    logger.info('campaign_reports_backfill_completed', { ...result, campaign_spends: undefined });
    return result;
  },
};
