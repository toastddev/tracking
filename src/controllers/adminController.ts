import type { Context } from 'hono';
import {
  offerRepository,
  networkRepository,
  conversionRepository,
  clickRepository,
} from '../firestore';
import { authService } from '../services/authService';
import { reportsService } from '../services/reportsService';
import { offerReportsService } from '../services/offerReportsService';
import { offerReportDetailService } from '../services/offerReportDetailService';
import { offerReportsBackfillService } from '../services/offerReportsBackfillService';
import { postbackReportsService } from '../services/postbackReportsService';
import { postbackReportDetailService } from '../services/postbackReportDetailService';
import { campaignReportsService } from '../services/campaignReportsService';
import { campaignReportDetailService } from '../services/campaignReportDetailService';
import { campaignReportsBackfillService } from '../services/campaignReportsBackfillService';
import { campaignReportRepository } from '../firestore';
import { googleAdsSyncStateRepository } from '../firestore';
import { googleAdsForwardingService } from '../services/googleAdsForwardingService';
import { googleAdsCampaignSyncService } from '../services/googleAdsCampaignSyncService';

import { dataResetService } from '../services/dataResetService';
import { logger } from '../utils/logger';

// Campaign IDs are external (Google Ads, UTM tags) so they can contain a
// wider set of characters than our internal isValidId regex allows. Restrict
// to a sensible safe set: alphanumerics, dash, underscore, dot. Length cap
// guards against pathological URLs.
function isValidCampaignId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_\-.]{0,127}$/.test(id);
}

function isValidDateKey(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function publicTrackingBase(): string {
  return (process.env.PUBLIC_TRACKING_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

// Base tracking URL. The frontend's offer detail page builds a ready-to-use
// link by appending the admin's chosen aff_id; we no longer bake a placeholder
// into the URL because that produces broken-looking links in the list view.
function trackingUrl(offer_id: string): string {
  return `${publicTrackingBase()}/click/${encodeURIComponent(offer_id)}`;
}

function postbackUrl(network_id: string): string {
  return `${publicTrackingBase()}/postback/${encodeURIComponent(network_id)}`;
}

function isValidId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_\-]{1,63}$/.test(id);
}

const CANONICAL_RE = /^[a-z][a-z0-9_]{0,31}$/;
const RESERVED_CANONICALS = new Set([
  'click_id', 'payout', 'currency', 'status', 'transaction_id', 'event_time',
]);

type ExtraResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string };

function parseExtraMappings(input: unknown): ExtraResult {
  if (input === undefined) return { ok: true, value: {} };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'invalid_extra_mappings' };
  }
  const out: Record<string, string> = {};
  const seenParams = new Set<string>();
  for (const [rawKey, rawVal] of Object.entries(input as Record<string, unknown>)) {
    const canonical = String(rawKey).trim().toLowerCase();
    const param = typeof rawVal === 'string' ? rawVal.trim() : '';
    if (!canonical && !param) continue;
    if (!canonical || !param) return { ok: false, error: 'invalid_extra_mappings' };
    if (!CANONICAL_RE.test(canonical)) return { ok: false, error: 'invalid_extra_mappings' };
    if (RESERVED_CANONICALS.has(canonical)) return { ok: false, error: 'reserved_extra_mapping' };
    if (canonical in out) return { ok: false, error: 'duplicate_extra_mapping' };
    const paramLower = param.toLowerCase();
    if (seenParams.has(paramLower)) return { ok: false, error: 'duplicate_extra_mapping_param' };
    seenParams.add(paramLower);
    out[canonical] = param;
  }
  return { ok: true, value: out };
}

function parseLimit(c: Context): number | undefined {
  const v = c.req.query('limit');
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export const adminController = {
  // ── auth ──────────────────────────────────────────────────────────
  async login(c: Context) {
    const body = await c.req.json().catch(() => ({})) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return c.json({ error: 'missing_credentials' }, 400);
    }
    const session = await authService.login(body.email, body.password);
    if (!session) return c.json({ error: 'invalid_credentials' }, 401);
    return c.json(session, 200);
  },

  me(c: Context) {
    const email = c.get('admin_email' as never) as string | undefined;
    return c.json({ email: email ?? null });
  },

  // ── offers ────────────────────────────────────────────────────────
  async listOffers(c: Context) {
    const result = await offerRepository.list({
      q: c.req.query('q'),
      cursor: c.req.query('cursor'),
      limit: parseLimit(c),
    });
    return c.json({
      items: result.items.map((o) => ({ ...o, tracking_url: trackingUrl(o.offer_id) })),
      nextCursor: result.nextCursor,
    });
  },

  async getOffer(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const offer = await offerRepository.getById(id);
    if (!offer) return c.json({ error: 'not_found' }, 404);
    return c.json({ ...offer, tracking_url: trackingUrl(offer.offer_id) });
  },

  async createOffer(c: Context) {
    const body = await c.req.json().catch(() => ({}));
    const offer_id = String(body.offer_id ?? '').trim();
    const name = String(body.name ?? '').trim();
    const base_url = String(body.base_url ?? '').trim();
    const status: 'active' | 'paused' = body.status === 'paused' ? 'paused' : 'active';
    const default_params = (body.default_params ?? {}) as Record<string, string>;

    if (!isValidId(offer_id)) return c.json({ error: 'invalid_offer_id' }, 400);
    if (!name) return c.json({ error: 'name_required' }, 400);
    if (!base_url) return c.json({ error: 'base_url_required' }, 400);

    try {
      const offer = await offerRepository.create(offer_id, { name, base_url, status, default_params });
      return c.json({ ...offer, tracking_url: trackingUrl(offer.offer_id) }, 201);
    } catch (err) {
      if (err instanceof Error && err.message === 'offer_already_exists') {
        return c.json({ error: 'offer_already_exists' }, 409);
      }
      logger.error('create_offer_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },

  async deleteOffer(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const ok = await offerRepository.delete(id);
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  },

  async updateOffer(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (typeof body.base_url === 'string') patch.base_url = body.base_url.trim();
    if (body.status === 'active' || body.status === 'paused') patch.status = body.status;
    if (body.default_params && typeof body.default_params === 'object') patch.default_params = body.default_params;

    const updated = await offerRepository.update(id, patch);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json({ ...updated, tracking_url: trackingUrl(updated.offer_id) });
  },

  // Pulls campaign names and ad spend directly from all connected Google Ads child accounts.
  // Idempotent and replaces any existing operator-entered spend for the matched campaigns
  // within the given date window.
  async syncGoogleAdsCampaigns(c: Context) {
    const body = await c.req.json().catch(() => ({})) as { from?: string; to?: string };
    const from = parseDate(body.from);
    const to = parseDate(body.to);
    
    // Default to 1st of current month → today when not provided
    const now = new Date();
    const effectiveFrom = from || new Date(now.getFullYear(), now.getMonth(), 1);
    const effectiveTo = to || now;

    if (effectiveFrom.getTime() > effectiveTo.getTime()) {
      return c.json({ error: 'from_after_to' }, 400);
    }
    try {
      const result = await googleAdsCampaignSyncService.syncCampaigns({ from: effectiveFrom, to: effectiveTo });
      return c.json({ ok: true, ...result });
    } catch (err) {
      logger.error('sync_google_ads_campaigns_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },

  async getGoogleAdsSyncState(c: Context) {
    const state = await googleAdsSyncStateRepository.get();
    return c.json(state);
  },

  async saveGoogleAdsSyncPrefs(c: Context) {
    const body = (await c.req.json().catch(() => ({}))) as { from?: unknown; to?: unknown };
    const from = typeof body.from === 'string' ? body.from : '';
    const to = typeof body.to === 'string' ? body.to : '';
    if (!isValidDateKey(from) || !isValidDateKey(to)) {
      return c.json({ error: 'invalid_date' }, 400);
    }
    if (from > to) return c.json({ error: 'from_after_to' }, 400);
    const state = await googleAdsSyncStateRepository.savePrefs({ from, to });
    return c.json(state);
  },

  // ── networks ──────────────────────────────────────────────────────
  async listNetworks(c: Context) {
    const result = await networkRepository.list({
      q: c.req.query('q'),
      cursor: c.req.query('cursor'),
      limit: parseLimit(c),
    });
    return c.json({
      items: result.items.map((n) => ({ ...n, postback_url: postbackUrl(n.network_id) })),
      nextCursor: result.nextCursor,
    });
  },

  async getNetwork(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const network = await networkRepository.getById(id);
    if (!network) return c.json({ error: 'not_found' }, 404);
    return c.json({ ...network, postback_url: postbackUrl(network.network_id) });
  },

  async createNetwork(c: Context) {
    const body = await c.req.json().catch(() => ({}));
    const network_id = String(body.network_id ?? '').trim();
    const name = String(body.name ?? '').trim();
    const status: 'active' | 'paused' = body.status === 'paused' ? 'paused' : 'active';
    const mapping_click_id = String(body.mapping_click_id ?? '').trim();

    if (!isValidId(network_id)) return c.json({ error: 'invalid_network_id' }, 400);
    if (!name) return c.json({ error: 'name_required' }, 400);
    if (!mapping_click_id) return c.json({ error: 'mapping_click_id_required' }, 400);

    const extras = parseExtraMappings(body.extra_mappings);
    if (!extras.ok) return c.json({ error: extras.error }, 400);

    const data = {
      name,
      status,
      mapping_click_id,
      mapping_payout: body.mapping_payout ? String(body.mapping_payout).trim() : undefined,
      mapping_currency: body.mapping_currency ? String(body.mapping_currency).trim() : undefined,
      mapping_status: body.mapping_status ? String(body.mapping_status).trim() : undefined,
      mapping_txn_id: body.mapping_txn_id ? String(body.mapping_txn_id).trim() : undefined,
      mapping_timestamp: body.mapping_timestamp ? String(body.mapping_timestamp).trim() : undefined,
      extra_mappings: extras.value,
      default_status: body.default_status ? String(body.default_status).trim() : undefined,
      postback_api_id: body.postback_api_id ? String(body.postback_api_id).trim() : undefined,
    };

    try {
      const network = await networkRepository.create(network_id, data);
      return c.json({ ...network, postback_url: postbackUrl(network.network_id) }, 201);
    } catch (err) {
      if (err instanceof Error && err.message === 'network_already_exists') {
        return c.json({ error: 'network_already_exists' }, 409);
      }
      logger.error('create_network_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },

  async deleteNetwork(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const ok = await networkRepository.delete(id);
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  },

  async updateNetwork(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};
    const fields = [
      'name', 'mapping_click_id', 'mapping_payout', 'mapping_currency',
      'mapping_status', 'mapping_txn_id', 'mapping_timestamp', 'default_status',
      'postback_api_id',
    ] as const;
    for (const f of fields) {
      if (typeof body[f] === 'string') patch[f] = (body[f] as string).trim() || undefined;
    }
    if (body.status === 'active' || body.status === 'paused') patch.status = body.status;

    if ('extra_mappings' in body) {
      const extras = parseExtraMappings(body.extra_mappings);
      if (!extras.ok) return c.json({ error: extras.error }, 400);
      patch.extra_mappings = extras.value;
    }

    const updated = await networkRepository.update(id, patch);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json({ ...updated, postback_url: postbackUrl(updated.network_id) });
  },

  // ── conversions ───────────────────────────────────────────────────
  async listNetworkConversions(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);

    const verifiedQ = c.req.query('verified');
    const verified =
      verifiedQ === 'true' ? true :
      verifiedQ === 'false' ? false :
      undefined;

    const result = await conversionRepository.listByNetwork({
      network_id: id,
      verified,
      from: parseDate(c.req.query('from')),
      to: parseDate(c.req.query('to')),
      cursor: c.req.query('cursor'),
      limit: parseLimit(c),
    });
    return c.json(result);
  },

  async getConversion(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const conv = await conversionRepository.getById(id);
    if (!conv) return c.json({ error: 'not_found' }, 404);

    // Hydrate the click so the UI has all the ad-id / sub-param / offer info
    // for a verified conversion. Skip on unverified to save a read.
    let click = null;
    if (conv.verified && conv.click_id) {
      click = await clickRepository.getById(conv.click_id);
    }
    return c.json({ conversion: conv, click });
  },

  // Cross-network conversions list (drives the Reports → Conversions &
  // Postbacks tabs). `verified` narrows the list; omitting it includes
  // both — the UI picks based on which tab is active.
  async listAllConversions(c: Context) {
    const verifiedQ = c.req.query('verified');
    const verified =
      verifiedQ === 'true' ? true :
      verifiedQ === 'false' ? false :
      undefined;

    const idsRaw = c.req.query('offer_ids');
    let offer_ids: string[] | undefined;
    if (idsRaw) {
      const list = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const oid of list) {
        if (!isValidId(oid)) return c.json({ error: 'invalid_offer_id' }, 400);
      }
      if (list.length > 30) return c.json({ error: 'too_many_offer_ids' }, 400);
      offer_ids = list;
    }

    const result = await conversionRepository.listAll({
      network_id: c.req.query('network_id'),
      offer_id: c.req.query('offer_id'),
      offer_ids,
      status: c.req.query('status'),
      verified,
      from: parseDate(c.req.query('from')),
      to: parseDate(c.req.query('to')),
      cursor: c.req.query('cursor'),
      limit: parseLimit(c),
    });
    return c.json(result);
  },

  // ── clicks ────────────────────────────────────────────────────────
  async getClick(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const click = await clickRepository.getById(id);
    if (!click) return c.json({ error: 'not_found' }, 404);
    // Hydrate any conversions that fired against this click so the UI shows
    // the full attribution chain in one place.
    const conversions = await conversionRepository.listByClickId(id, 50).catch(() => []);
    return c.json({ click, conversions });
  },

  async listClicks(c: Context) {
    const result = await clickRepository.list({
      offer_id: c.req.query('offer_id'),
      aff_id: c.req.query('aff_id'),
      from: parseDate(c.req.query('from')),
      to: parseDate(c.req.query('to')),
      cursor: c.req.query('cursor'),
      limit: parseLimit(c),
    });
    return c.json(result);
  },

  // ── reports ───────────────────────────────────────────────────────
  async reportSummary(c: Context) {
    const parsed = parseReportFilters(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      const summary = await reportsService.summary(parsed.filters);
      return c.json(summary);
    } catch (err) {
      logger.error('report_summary_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },

  async reportTimeseries(c: Context) {
    const parsed = parseReportFilters(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      const points = await reportsService.timeseries(parsed.filters);
      return c.json({ points });
    } catch (err) {
      logger.error('report_timeseries_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },

  // Per-offer aggregated reports drawn from the offer_reports rollup
  // collection (TTL-safe). Accepts an optional offer_ids list (comma-
  // separated) so the UI can persist a multi-select locally and only ask
  // the backend for what it intends to show.
  async reportOffers(c: Context) {
    const parsed = parseReportFilters(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const idsRaw = c.req.query('offer_ids');
    let offer_ids: string[] | undefined;
    if (idsRaw) {
      const list = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const id of list) {
        if (!isValidId(id)) return c.json({ error: 'invalid_offer_id' }, 400);
      }
      // Cap the list — Firestore parallel queries are cheap but not free.
      if (list.length > 50) return c.json({ error: 'too_many_offer_ids' }, 400);
      offer_ids = list;
    }
    try {
      const result = await offerReportsService.perOfferSummary({
        from: parsed.filters.from,
        to: parsed.filters.to,
        offer_ids,
      });
      return c.json(result);
    } catch (err) {
      logger.error('report_offers_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },

  // Single-offer drill-down. Returns summary + period-over-period deltas,
  // dense daily series, and on-the-fly breakdowns (top affiliates, countries,
  // sub-IDs, networks, ad platforms, hour heatmap, payout histogram, flags)
  // computed by materialising raw clicks & conversions for the offer in the
  // window. The breakdowns are capped at the most recent 20k clicks / 10k
  // conversions; the response surfaces a truncated flag when the cap is hit.
  async reportOfferDetail(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const parsed = parseReportFilters(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      const detail = await offerReportDetailService.getDetail({
        offer_id: id,
        from: parsed.filters.from,
        to: parsed.filters.to,
      });
      return c.json(detail);
    } catch (err) {
      logger.error('report_offer_detail_failed', {
        offer_id: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'internal' }, 500);
    }
  },

  // Per-network postback summary. Distinct from offer reports: the operator
  // is asking "is the network's S2S delivery healthy and matching our clicks?"
  // not "is this offer making me money?". Match-rate, not CVR, is the
  // headline metric. Backed by a single capped conversion range scan.
  async reportPostbacks(c: Context) {
    const parsed = parseReportFilters(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const idsRaw = c.req.query('network_ids');
    let network_ids: string[] | undefined;
    if (idsRaw) {
      const list = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const id of list) {
        if (!isValidId(id)) return c.json({ error: 'invalid_network_id' }, 400);
      }
      if (list.length > 50) return c.json({ error: 'too_many_network_ids' }, 400);
      network_ids = list;
    }
    try {
      const result = await postbackReportsService.perNetworkSummary({
        from: parsed.filters.from,
        to: parsed.filters.to,
        network_ids,
      });
      return c.json(result);
    } catch (err) {
      logger.error('report_postbacks_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },

  // Single-network postback drill-down. Surfaces match-rate, status grading,
  // mapping coverage, latency between event and ingest, source/method splits,
  // and unmatched-fire samples — the tools an operator needs to debug a sick
  // S2S integration.
  async reportPostbackDetail(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidId(id)) return c.json({ error: 'invalid_id' }, 400);
    const parsed = parseReportFilters(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const idsRaw = c.req.query('offer_ids');
    let offer_ids: string[] | undefined;
    if (idsRaw) {
      const list = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const oid of list) {
        if (!isValidId(oid)) return c.json({ error: 'invalid_offer_id' }, 400);
      }
      if (list.length > 50) return c.json({ error: 'too_many_offer_ids' }, 400);
      offer_ids = list;
    }

    try {
      const detail = await postbackReportDetailService.getDetail({
        network_id: id,
        from: parsed.filters.from,
        to: parsed.filters.to,
        offer_ids,
      });
      return c.json(detail);
    } catch (err) {
      logger.error('report_postback_detail_failed', {
        network_id: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'internal' }, 500);
    }
  },

  // Rebuild the offer_reports rollup from the source clicks + conversions.
  // Idempotent — safe to re-run. Accepts optional `from`/`to` ISO strings to
  // narrow the rebuild window; defaults to the last 120 days.
  async backfillOfferReports(c: Context) {
    const body = await c.req.json().catch(() => ({})) as { from?: string; to?: string };
    const from = parseDate(body.from);
    const to = parseDate(body.to);
    if (from && to && from.getTime() > to.getTime()) {
      return c.json({ error: 'from_after_to' }, 400);
    }
    try {
      const result = await offerReportsBackfillService.rebuild({ from, to });
      return c.json({ ok: true, ...result });
    } catch (err) {
      logger.error('offer_reports_backfill_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },

  // ── campaign reports ──────────────────────────────────────────────
  // Per-campaign aggregates from the campaign_reports rollup. Campaign id
  // comes from the gad_campaignid URL param (Google Ads) with utm_campaign
  // as the cross-platform fallback. Same date semantics as the offer report.
  async reportCampaigns(c: Context) {
    const parsed = parseReportFilters(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const idsRaw = c.req.query('campaign_ids');
    let campaign_ids: string[] | undefined;
    if (idsRaw) {
      const list = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const id of list) {
        if (!isValidCampaignId(id)) return c.json({ error: 'invalid_campaign_id' }, 400);
      }
      if (list.length > 50) return c.json({ error: 'too_many_campaign_ids' }, 400);
      campaign_ids = list;
    }
    try {
      const result = await campaignReportsService.perCampaignSummary({
        from: parsed.filters.from,
        to: parsed.filters.to,
        campaign_ids,
      });
      return c.json(result);
    } catch (err) {
      logger.error('report_campaigns_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },

  async reportCampaignDetail(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidCampaignId(id)) return c.json({ error: 'invalid_campaign_id' }, 400);
    const parsed = parseReportFilters(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      const detail = await campaignReportDetailService.getDetail({
        campaign_id: id,
        from: parsed.filters.from,
        to: parsed.filters.to,
      });
      return c.json(detail);
    } catch (err) {
      logger.error('report_campaign_detail_failed', {
        campaign_id: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'internal' }, 500);
    }
  },

  // Operator-entered ad spend for a single campaign-day. Body: { date, spend }.
  // `spend` is a positive dollar amount; the rollup stores it verbatim so
  // ROAS/ROI compute on read.
  async updateCampaignSpend(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidCampaignId(id)) return c.json({ error: 'invalid_campaign_id' }, 400);
    const body = await c.req.json().catch(() => ({})) as { date?: string; spend?: number };
    const date = String(body.date ?? '').trim();
    if (!isValidDateKey(date)) return c.json({ error: 'invalid_date' }, 400);
    const spend = Number(body.spend);
    if (!Number.isFinite(spend) || spend < 0) return c.json({ error: 'invalid_spend' }, 400);
    try {
      await campaignReportRepository.updateSpend({ campaign_id: id, date, spend });
      return c.json({ ok: true, campaign_id: id, date, spend });
    } catch (err) {
      logger.error('update_campaign_spend_failed', {
        campaign_id: id, date, error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'internal' }, 500);
    }
  },

  // Rebuild the campaign_reports rollup from source clicks + conversions.
  // Idempotent and safe to re-run. Operator-entered spend / display names
  // survive (the backfill uses set-merge and omits those fields). Accepts
  // optional `from`/`to` ISO strings; defaults to the last 120 days.
  async backfillCampaignReports(c: Context) {
    const body = await c.req.json().catch(() => ({})) as { from?: string; to?: string };
    const from = parseDate(body.from);
    const to = parseDate(body.to);
    if (from && to && from.getTime() > to.getTime()) {
      return c.json({ error: 'from_after_to' }, 400);
    }
    try {
      const result = await campaignReportsBackfillService.rebuild({ from, to });
      return c.json({ ok: true, ...result });
    } catch (err) {
      logger.error('campaign_reports_backfill_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'internal' }, 500);
    }
  },

  // Optional human-readable name. Lets the operator label `gad_campaignid`
  // numbers like "Spring sale 2026" without having to wait on a Google Ads
  // API integration.
  async updateCampaignName(c: Context) {
    const id = c.req.param('id');
    if (!id || !isValidCampaignId(id)) return c.json({ error: 'invalid_campaign_id' }, 400);
    const body = await c.req.json().catch(() => ({})) as { campaign_name?: string };
    const name = String(body.campaign_name ?? '').trim();
    if (!name) return c.json({ error: 'name_required' }, 400);
    try {
      await campaignReportRepository.updateName({ campaign_id: id, campaign_name: name });
      return c.json({ ok: true, campaign_id: id, campaign_name: name });
    } catch (err) {
      logger.error('update_campaign_name_failed', {
        campaign_id: id, error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'internal' }, 500);
    }
  },

  // ── settings / data reset ─────────────────────────────────────────
  async resetData(c: Context) {
    const body = await c.req.json().catch(() => ({})) as { confirm?: string };
    // Server-side confirmation token: the client must echo "RESET" so a
    // misclick won't wipe the database.
    if (body.confirm !== 'RESET') {
      return c.json({ error: 'confirmation_required' }, 400);
    }
    const actor = (c.get('admin_email' as never) as string | undefined) ?? 'unknown';
    try {
      const result = await dataResetService.resetIncomingData(actor);
      return c.json({ ok: true, ...result });
    } catch (err) {
      logger.error('data_reset_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },
};

// ── helpers ──────────────────────────────────────────────────────────
const MAX_RANGE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

type FilterParseResult =
  | { ok: true; filters: { from: Date; to: Date; offer_id?: string; network_id?: string } }
  | { ok: false; error: string };

function parseReportFilters(c: Context): FilterParseResult {
  const now = new Date();
  const to = parseDate(c.req.query('to')) ?? now;
  // Default: last 30 days.
  const defaultFrom = new Date(to.getTime() - 30 * DAY_MS);
  const from = parseDate(c.req.query('from')) ?? defaultFrom;

  if (from.getTime() > to.getTime()) return { ok: false, error: 'from_after_to' };
  const spanMs = to.getTime() - from.getTime();
  if (spanMs > MAX_RANGE_DAYS * DAY_MS) return { ok: false, error: 'range_too_large' };

  const offer_id = c.req.query('offer_id');
  const network_id = c.req.query('network_id');
  if (offer_id && !isValidId(offer_id)) return { ok: false, error: 'invalid_offer_id' };
  if (network_id && !isValidId(network_id)) return { ok: false, error: 'invalid_network_id' };

  return { ok: true, filters: { from, to, offer_id, network_id } };
}
