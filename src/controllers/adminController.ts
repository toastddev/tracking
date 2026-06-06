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
import { campaignReportRepository, facebookCampaignReportRepository } from '../firestore';
import { googleAdsSyncStateRepository } from '../firestore';
import { googleAdsForwardingService } from '../services/googleAdsForwardingService';
import { googleAdsCampaignSyncService } from '../services/googleAdsCampaignSyncService';
import { refreshService } from '../services/refreshService';

import { dataResetService } from '../services/dataResetService';
import { logger } from '../utils/logger';
import { csvEscape } from '../utils/csv';

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

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

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

// Parses the operator-set offer↔campaign linkage. Each field is independently
// optional; either all three are set (full linkage) or all three are blank
// (offer floats unattached). Used on create — update has its own per-field
// nullable handling because PATCH semantics differ.
type LinkageResult =
  | { value: { traffic_source?: 'google' | 'facebook'; linked_campaign_id?: string; link_type?: 'direct' | 'normal' } }
  | { error: string };
function parseOfferLinkage(body: Record<string, unknown>): LinkageResult {
  const out: { traffic_source?: 'google' | 'facebook'; linked_campaign_id?: string; link_type?: 'direct' | 'normal' } = {};
  if (body.traffic_source != null && body.traffic_source !== '') {
    if (body.traffic_source !== 'google' && body.traffic_source !== 'facebook') return { error: 'invalid_traffic_source' };
    out.traffic_source = body.traffic_source;
  }
  if (body.linked_campaign_id != null && body.linked_campaign_id !== '') {
    if (typeof body.linked_campaign_id !== 'string' || !isValidCampaignId(body.linked_campaign_id)) return { error: 'invalid_linked_campaign_id' };
    out.linked_campaign_id = body.linked_campaign_id;
  }
  if (body.link_type != null && body.link_type !== '') {
    if (body.link_type !== 'direct' && body.link_type !== 'normal') return { error: 'invalid_link_type' };
    out.link_type = body.link_type;
  }
  return { value: out };
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

    const linkage = parseOfferLinkage(body);
    if ('error' in linkage) return c.json({ error: linkage.error }, 400);

    try {
      const offer = await offerRepository.create(offer_id, {
        name,
        base_url,
        status,
        default_params,
        ...linkage.value,
      });
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

    // Linkage fields are nullable: passing `null` explicitly clears them, leaving
    // them undefined leaves the stored value alone.
    if ('traffic_source' in body) {
      if (body.traffic_source === null || body.traffic_source === '') patch.traffic_source = null;
      else if (body.traffic_source === 'google' || body.traffic_source === 'facebook') patch.traffic_source = body.traffic_source;
      else return c.json({ error: 'invalid_traffic_source' }, 400);
    }
    if ('linked_campaign_id' in body) {
      if (body.linked_campaign_id === null || body.linked_campaign_id === '') patch.linked_campaign_id = null;
      else if (typeof body.linked_campaign_id === 'string' && isValidCampaignId(body.linked_campaign_id)) patch.linked_campaign_id = body.linked_campaign_id;
      else return c.json({ error: 'invalid_linked_campaign_id' }, 400);
    }
    if ('link_type' in body) {
      if (body.link_type === null || body.link_type === '') patch.link_type = null;
      else if (body.link_type === 'direct' || body.link_type === 'normal') patch.link_type = body.link_type;
      else return c.json({ error: 'invalid_link_type' }, 400);
    }

    const updated = await offerRepository.update(id, patch);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json({ ...updated, tracking_url: trackingUrl(updated.offer_id) });
  },

  // Searches across recorded campaigns for the offer-linkage form. `source`
  // toggles between the GAds and FB campaign-report collections; `q` is a
  // case-insensitive substring matched against either campaign_name or
  // campaign_id so the operator can find a campaign by either.
  async searchCampaigns(c: Context) {
    const source = c.req.query('source');
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const limit = Math.min(Math.max(parseLimit(c) ?? 25, 1), 100);
    if (source !== 'google' && source !== 'facebook') return c.json({ error: 'invalid_source' }, 400);

    const all = source === 'google'
      ? await campaignReportRepository.listDistinct()
      : await facebookCampaignReportRepository.listDistinct();

    const filtered = q
      ? all.filter((row) =>
          row.campaign_id.toLowerCase().includes(q) ||
          (row.campaign_name?.toLowerCase().includes(q) ?? false))
      : all;

    // Prefer rows with a campaign_name first — these are the operator-named
    // campaigns from a successful GAds/FB sync. Then alphabetical so results
    // are stable across calls.
    filtered.sort((a, b) => {
      const an = a.campaign_name ? 0 : 1;
      const bn = b.campaign_name ? 0 : 1;
      if (an !== bn) return an - bn;
      return (a.campaign_name ?? a.campaign_id).localeCompare(b.campaign_name ?? b.campaign_id);
    });

    return c.json({ items: filtered.slice(0, limit) });
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
      postback_timezone: undefined as string | undefined,
    };

    // Validate and set postback_timezone (IANA tz for Google Ads upload only).
    if (typeof body.postback_timezone === 'string' && body.postback_timezone.trim()) {
      const tz = body.postback_timezone.trim();
      if (!isValidTimezone(tz)) return c.json({ error: 'invalid_postback_timezone' }, 400);
      data.postback_timezone = tz;
    }

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

    // postback_timezone: allow setting and clearing (empty string = remove).
    if ('postback_timezone' in body) {
      const raw = typeof body.postback_timezone === 'string' ? body.postback_timezone.trim() : '';
      if (raw) {
        if (!isValidTimezone(raw)) return c.json({ error: 'invalid_postback_timezone' }, 400);
        patch.postback_timezone = raw;
      } else {
        patch.postback_timezone = undefined;
      }
    }
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

  // Single-shot CSV export of every click in the window — no cursor walking,
  // one Firestore query, response streamed straight to the browser. The
  // returned CSV expands sub_params / ad_ids / extra_params into dynamic
  // columns built from the union of keys seen so the operator gets every
  // dimension that exists in the data.
  async exportClicks(c: Context) {
    const from = parseDate(c.req.query('from'));
    const to = parseDate(c.req.query('to'));
    if (!from || !to) return c.json({ error: 'from_and_to_required' }, 400);
    if (from.getTime() > to.getTime()) return c.json({ error: 'from_after_to' }, 400);

    const MAX = Number(process.env.CLICK_EXPORT_MAX ?? 100_000);
    const t0 = Date.now();
    const rows = await clickRepository.fetchAllForExport({
      from,
      to,
      offer_id: c.req.query('offer_id') || undefined,
      aff_id: c.req.query('aff_id') || undefined,
      max: MAX,
    });

    // Discover every sub_/ad_/extra_ key present in the result so the CSV
    // has a column for each — no "extra_count" placeholder, the operator gets
    // the raw values.
    const subKeys = new Set<string>();
    const adKeys = new Set<string>();
    const extraKeys = new Set<string>();
    for (const r of rows) {
      for (const k of Object.keys(r.sub_params ?? {})) subKeys.add(k);
      for (const k of Object.keys(r.ad_ids ?? {})) adKeys.add(k);
      for (const k of Object.keys(r.extra_params ?? {})) extraKeys.add(k);
    }
    const subCols = Array.from(subKeys).sort();
    const adCols = Array.from(adKeys).sort();
    const extraCols = Array.from(extraKeys).sort();

    const headers = [
      'created_at',
      'click_id',
      'offer_id',
      'aff_id',
      'country',
      'ip',
      'user_agent',
      'referrer',
      'redirect_url',
      'blocked',
      ...subCols.map((k) => `sub_${k}`),
      ...adCols.map((k) => `ad_${k}`),
      ...extraCols.map((k) => `extra_${k}`),
    ];

    const out: string[] = [];
    out.push(headers.map(csvEscape).join(','));
    for (const r of rows) {
      const sub = r.sub_params ?? {};
      const ad = (r.ad_ids ?? {}) as Record<string, string | undefined>;
      const extra = r.extra_params ?? {};
      const row: string[] = [
        r.created_at ?? '',
        r.click_id ?? '',
        r.offer_id ?? '',
        r.aff_id ?? '',
        r.country ?? '',
        r.ip ?? '',
        r.user_agent ?? '',
        r.referrer ?? '',
        r.redirect_url ?? '',
        r.blocked ? 'true' : 'false',
        ...subCols.map((k) => sub[k] ?? ''),
        ...adCols.map((k) => ad[k] ?? ''),
        ...extraCols.map((k) => extra[k] ?? ''),
      ];
      out.push(row.map(csvEscape).join(','));
    }
    // UTF-8 BOM so Excel renders non-ASCII (₹, etc.) correctly on Windows.
    const body = '﻿' + out.join('\r\n');
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    logger.info('clicks_export', {
      rows: rows.length,
      max: MAX,
      truncated: rows.length >= MAX,
      duration_ms: Date.now() - t0,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header(
      'Content-Disposition',
      `attachment; filename="clicks_${stamp}.csv"`
    );
    c.header('X-Row-Count', String(rows.length));
    if (rows.length >= MAX) c.header('X-Export-Truncated', '1');
    return c.body(body);
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

  // Combined summary + timeseries — one Firestore scan covers both. The
  // /reports page uses this in place of two separate endpoints.
  async reportOverview(c: Context) {
    const parsed = parseReportFilters(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      const overview = await reportsService.overview(parsed.filters);
      return c.json(overview);
    } catch (err) {
      logger.error('report_overview_failed', { error: err instanceof Error ? err.message : String(err) });
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

  // ── refresh (orchestrated) ────────────────────────────────────────
  // Runs every active affiliate API sequentially, then runs the offer +
  // campaign report backfills from the last successful refresh timestamp
  // (or DEFAULT_LOOKBACK_DAYS for a first refresh).
  //
  // Multi-instance safety: serialised by a leased Firestore lock in
  // app_state/refresh_state. If another Cloud Run instance (or a second
  // operator click) is already running a refresh, returns 409 with the
  // active run_id so the UI can attach to its progress instead of erroring.
  //
  // The HTTP request blocks until the run completes, but the client should
  // also poll /api/refresh/runs/:id for live step-by-step progress. Polling
  // is what surfaces in-flight progress to the UI; the response body just
  // confirms terminal status.
  async refreshAll(c: Context) {
    try {
      const result = await refreshService.refreshAll();
      if (!result.ok) {
        return c.json(
          {
            error: result.reason ?? 'refresh_failed',
            active_run_id: result.active_run_id,
            active_started_at: result.active_started_at,
          },
          409
        );
      }
      // Pull the final run state so the client gets a single response with
      // all the info it needs without an extra round-trip.
      const run = result.run_id ? await refreshService.getRun(result.run_id) : null;
      return c.json({ ok: true, run_id: result.run_id, run });
    } catch (err) {
      logger.error('refresh_all_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'refresh_failed', message: err instanceof Error ? err.message : String(err) }, 500);
    }
  },

  async refreshStatus(c: Context) {
    try {
      const status = await refreshService.getStatus();
      return c.json(status);
    } catch (err) {
      logger.error('refresh_status_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },

  async refreshRun(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    try {
      const run = await refreshService.getRun(id);
      if (!run) return c.json({ error: 'not_found' }, 404);
      return c.json(run);
    } catch (err) {
      logger.error('refresh_run_lookup_failed', {
        run_id: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'internal' }, 500);
    }
  },

  // Admin force-unlock for the orchestrated refresh. Used when an operator
  // killed the holder instance mid-run and doesn't want to wait for the
  // 30-min lease to expire before another refresh can start.
  async refreshUnlock(c: Context) {
    try {
      const result = await refreshService.forceUnlock();
      return c.json(result);
    } catch (err) {
      logger.error('refresh_unlock_failed', {
        error: err instanceof Error ? err.message : String(err),
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

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

type FilterParseResult =
  | { ok: true; filters: { from: Date; to: Date; offer_id?: string; network_id?: string } }
  | { ok: false; error: string };

function parseReportFilters(c: Context): FilterParseResult {
  const now = new Date();
  const to = parseDate(c.req.query('to')) ?? now;
  // Default: current UTC calendar month, matching the dashboard preset.
  const defaultFrom = startOfUtcMonth(to);
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
