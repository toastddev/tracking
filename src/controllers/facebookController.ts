import type { Context } from 'hono';
import {
  buildFbRouteId,
  clickRepository,
  conversionRepository,
  COLLECTIONS,
  db,
  facebookConnectionRepository,
  facebookBusinessChildrenRepository,
  facebookRouteRepository,
  facebookUploadRepository,
  facebookSyncStateRepository,
  networkRepository,
  offerRepository,
} from '../firestore';
import type { ClickRecord, ConversionRecord } from '../types';
import { extractFbCampaign } from '../services/facebookCampaignExtractor';
import { generateConversionId } from '../utils/idGenerator';
import { encryptSecret } from '../utils/crypto';
import { logger } from '../utils/logger';
import { csvEscape } from '../utils/csv';
import { facebookOauthService } from '../services/facebookOauthService';
import { facebookAccountService } from '../services/facebookAccountService';
import { facebookForwardingService } from '../services/facebookForwardingService';
import { facebookCampaignSyncService } from '../services/facebookCampaignSyncService';
import { signFbGrantToken, verifyFbGrantToken } from '../utils/facebookOauthState';
import type {
  FacebookCandidate,
  FacebookConnection,
  FacebookConnectionPublic,
  FacebookConnectionType,
  FacebookRouteScope,
} from '../types/facebookAds';

// Mirror of ./googleAdsController.ts. Same section breakdown: OAuth →
// Connections CRUD → Conversion-events (Meta custom events + standard events)
// → Routes → Uploads (incl. retry + CSV export) → Sync.

function getAdminEmail(c: Context): string {
  return (c.get('admin_email' as never) as string | undefined) ?? '';
}

function publicConnection(conn: FacebookConnection): FacebookConnectionPublic {
  return {
    connection_id: conn.connection_id,
    type: conn.type,
    meta_user_email: conn.meta_user_email,
    access_token_expires_at: conn.access_token_expires_at,
    business_id: conn.business_id,
    ad_account_id: conn.ad_account_id,
    dataset_id: conn.dataset_id,
    dataset_name: conn.dataset_name,
    name: conn.name,
    currency_code: conn.currency_code,
    time_zone: conn.time_zone,
    account_status: conn.account_status,
    sale_event_name: conn.sale_event_name,
    sale_event_dataset_id: conn.sale_event_dataset_id,
    click_event_name: conn.click_event_name,
    click_event_dataset_id: conn.click_event_dataset_id,
    status: conn.status,
    last_error: conn.last_error,
    created_at: conn.created_at,
    updated_at: conn.updated_at,
  };
}

function isValidId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_\-]{1,63}$/.test(id);
}

function isValidAdAccountId(id: string): boolean {
  return /^act_\d{6,20}$/.test(id);
}

function isValidBusinessId(id: string): boolean {
  return /^\d{6,20}$/.test(id);
}

function isValidEventName(name: string): boolean {
  // Meta event names: alphanumeric + underscores, up to 50 chars. Standard
  // events and operator-registered custom events both fit this.
  return /^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(name);
}

export const facebookController = {
  // ── OAuth ─────────────────────────────────────────────────────────
  async oauthStart(c: Context) {
    const body = await c.req.json().catch(() => ({})) as { type?: string };
    const type: FacebookConnectionType | null =
      body.type === 'business' ? 'business' : body.type === 'ad_account' ? 'ad_account' : null;
    if (!type) return c.json({ error: 'invalid_type' }, 400);
    try {
      const result = await facebookOauthService.buildAuthUrl({
        admin_email: getAdminEmail(c),
        type,
      });
      logger.info('fb_oauth_started', { type, admin_email: getAdminEmail(c) });
      return c.json(result);
    } catch (err) {
      logger.error('fb_oauth_start_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'oauth_misconfigured' }, 500);
    }
  },

  async oauthExchange(c: Context) {
    const body = await c.req.json().catch(() => ({})) as { code?: string; state?: string };
    if (!body.code || !body.state) return c.json({ error: 'missing_code_or_state' }, 400);

    const adminEmail = getAdminEmail(c);
    const state = await facebookOauthService.verifyState(body.state, adminEmail);
    if (!state) return c.json({ error: 'invalid_state' }, 400);

    let exchanged;
    try {
      exchanged = await facebookOauthService.exchangeCode(body.code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('fb_oauth_exchange_failed', { error: msg });
      return c.json({ error: 'oauth_exchange_failed', message: msg }, 400);
    }

    const access_token_enc = encryptSecret(exchanged.access_token_long_lived);

    let candidates: FacebookCandidate[];
    try {
      candidates = await facebookAccountService.listAccessibleFromGrant(access_token_enc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('fb_list_accessible_failed', { error: msg });
      return c.json({ error: 'list_accessible_failed', message: msg }, 502);
    }
    if (candidates.length === 0) return c.json({ error: 'no_accessible_accounts' }, 400);

    const grant_token = await signFbGrantToken({
      access_token_enc,
      access_token_expires_at: exchanged.expires_at_iso,
      meta_user_email: exchanged.meta_user_email,
      scopes: exchanged.scopes,
      type: state.type,
    });

    return c.json({
      grant_token,
      type: state.type,
      meta_user_email: exchanged.meta_user_email,
      access_token_expires_at: exchanged.expires_at_iso,
      candidates,
    });
  },

  async finalize(c: Context) {
    const body = await c.req.json().catch(() => ({})) as {
      grant_token?: string;
      picks?: Array<{
        type?: string;
        id?: string;                  // 'act_<id>' for ad_account, BM id for business
        business_id?: string;
        name?: string;
        currency_code?: string;
        time_zone?: string;
        account_status?: string;
      }>;
      business_children?: Array<{
        ad_account_id?: string;
        name?: string;
        currency_code?: string;
        time_zone?: string;
        account_status?: string;
      }>;
    };
    if (!body.grant_token) return c.json({ error: 'missing_grant_token' }, 400);
    const grant = await verifyFbGrantToken(body.grant_token);
    if (!grant) return c.json({ error: 'invalid_grant_token' }, 400);

    const picks = Array.isArray(body.picks) ? body.picks : [];
    if (picks.length === 0) return c.json({ error: 'no_picks' }, 400);

    const out: FacebookConnection[] = [];

    for (const p of picks) {
      const pickType: FacebookConnectionType | null =
        p.type === 'business' ? 'business' : p.type === 'ad_account' ? 'ad_account' : null;
      if (!pickType || pickType !== grant.type) continue;

      const rawId = String(p.id ?? '').trim();
      let ad_account_id = '';
      let business_id: string | undefined;

      if (pickType === 'ad_account') {
        if (!isValidAdAccountId(rawId)) continue;
        ad_account_id = rawId;
        business_id = p.business_id && isValidBusinessId(p.business_id) ? p.business_id : undefined;
      } else {
        if (!isValidBusinessId(rawId)) continue;
        business_id = rawId;
        // For a business connection we still need ad_account_id as a sane
        // default destination for sync — leave blank if not provided; the sync
        // service falls back to the cached children list.
        ad_account_id = '';
      }

      const connection_id = generateConversionId();
      const conn = await facebookConnectionRepository.insert({
        connection_id,
        type: pickType,
        meta_user_email: grant.meta_user_email,
        access_token_enc: grant.access_token_enc,
        access_token_expires_at: grant.access_token_expires_at,
        business_id,
        ad_account_id,
        name: p.name ?? '',
        currency_code: p.currency_code ?? '',
        time_zone: p.time_zone ?? '',
        account_status: p.account_status,
        scopes: grant.scopes,
        status: 'active',
      });
      out.push(conn);
      logger.info('fb_connection_created', {
        connection_id,
        type: pickType,
        ad_account_id,
        business_id,
      });

      if (pickType === 'business' && Array.isArray(body.business_children)) {
        const children = body.business_children
          .map((c) => ({
            ad_account_id: String(c.ad_account_id ?? ''),
            name: c.name ?? '',
            currency_code: c.currency_code ?? '',
            time_zone: c.time_zone ?? '',
            account_status: c.account_status,
          }))
          .filter((c) => isValidAdAccountId(c.ad_account_id));
        if (children.length > 0) {
          await facebookBusinessChildrenRepository.upsertMany(connection_id, children);
        }
      }
    }

    if (out.length === 0) return c.json({ error: 'no_valid_picks' }, 400);
    return c.json({ items: out.map(publicConnection) }, 201);
  },

  // ── Connections ────────────────────────────────────────────────────
  async listConnections(c: Context) {
    const items = await facebookConnectionRepository.list();
    return c.json({ items: items.map(publicConnection) });
  },

  async getConnection(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const conn = await facebookConnectionRepository.getById(id);
    if (!conn) return c.json({ error: 'not_found' }, 404);
    let business_children = undefined;
    if (conn.type === 'business') {
      business_children = await facebookBusinessChildrenRepository.listByConnection(id);
    }
    return c.json({ connection: publicConnection(conn), business_children });
  },

  async deleteConnection(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    await facebookBusinessChildrenRepository.deleteByConnection(id);
    const ok = await facebookConnectionRepository.delete(id);
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  },

  async refreshBusinessChildren(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const conn = await facebookConnectionRepository.getById(id);
    if (!conn) return c.json({ error: 'not_found' }, 404);
    if (conn.type !== 'business') return c.json({ error: 'not_business' }, 400);
    if (!conn.business_id) return c.json({ error: 'no_business_id' }, 400);

    let accounts;
    try {
      accounts = await facebookAccountService.discoverBusinessAdAccounts({
        access_token_enc: conn.access_token_enc,
        businessId: conn.business_id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'discover_failed', message: msg }, 502);
    }

    const children = accounts.map((a) => ({
      ad_account_id: a.id,
      name: a.name,
      currency_code: a.currency_code,
      time_zone: a.time_zone,
      account_status: a.account_status,
    }));
    if (children.length > 0) {
      await facebookBusinessChildrenRepository.upsertMany(conn.connection_id, children);
    }
    facebookConnectionRepository.invalidate(id);
    return c.json({ business_children: children });
  },

  // Patch the mappings on a connection.
  async patchConnection(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const body = await c.req.json().catch(() => ({})) as {
      dataset_id?: string | null;
      dataset_name?: string | null;
      sale_event_name?: string | null;
      sale_event_dataset_id?: string | null;
      click_event_name?: string | null;
      click_event_dataset_id?: string | null;
    };
    const patch: Parameters<typeof facebookConnectionRepository.update>[1] = {};
    if (body.dataset_id !== undefined) {
      patch.dataset_id = body.dataset_id?.trim() || undefined;
    }
    if (body.dataset_name !== undefined) {
      patch.dataset_name = body.dataset_name?.trim() || undefined;
    }
    if (body.sale_event_name !== undefined) {
      const v = body.sale_event_name?.trim();
      if (v && !isValidEventName(v)) return c.json({ error: 'invalid_sale_event_name' }, 400);
      patch.sale_event_name = v || undefined;
    }
    if (body.sale_event_dataset_id !== undefined) {
      patch.sale_event_dataset_id = body.sale_event_dataset_id?.trim() || undefined;
    }
    if (body.click_event_name !== undefined) {
      const v = body.click_event_name?.trim();
      if (v && !isValidEventName(v)) return c.json({ error: 'invalid_click_event_name' }, 400);
      patch.click_event_name = v || undefined;
    }
    if (body.click_event_dataset_id !== undefined) {
      patch.click_event_dataset_id = body.click_event_dataset_id?.trim() || undefined;
    }
    const updated = await facebookConnectionRepository.update(id, patch);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    logger.info('fb_connection_events_set', {
      connection_id: id,
      sale: updated.sale_event_name,
      click: updated.click_event_name,
    });
    return c.json(publicConnection(updated));
  },

  async listDatasets(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const conn = await facebookConnectionRepository.getById(id);
    if (!conn) return c.json({ error: 'not_found' }, 404);
    try {
      const datasets = await facebookAccountService.listDatasets({
        connection: conn,
        forceRefresh: c.req.query('refresh') === 'true',
      });
      return c.json({ items: datasets });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'list_failed', message: msg }, 502);
    }
  },

  async listCustomEvents(c: Context) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const conn = await facebookConnectionRepository.getById(id);
    if (!conn) return c.json({ error: 'not_found' }, 404);
    try {
      const actions = await facebookAccountService.listCustomEvents({
        connection: conn,
        dataset_id: c.req.query('dataset_id') || undefined,
        forceRefresh: c.req.query('refresh') === 'true',
      });
      return c.json({ items: actions });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'list_failed', message: msg }, 502);
    }
  },

  // ── Routes ────────────────────────────────────────────────────────
  async upsertRoute(c: Context) {
    const body = await c.req.json().catch(() => ({})) as {
      scope_type?: string;
      scope_id?: string;
      target_connection_id?: string;
      sale_event_name?: string;
      sale_event_dataset_id?: string;
      click_event_name?: string;
      click_event_dataset_id?: string;
      enabled?: boolean;
    };
    const scope_type: FacebookRouteScope | null =
      body.scope_type === 'offer' ? 'offer' :
      body.scope_type === 'network' ? 'network' :
      null;
    if (!scope_type) return c.json({ error: 'invalid_scope_type' }, 400);
    const scope_id = String(body.scope_id ?? '').trim();
    if (!isValidId(scope_id)) return c.json({ error: 'invalid_scope_id' }, 400);

    if (scope_type === 'offer') {
      const offer = await offerRepository.getById(scope_id);
      if (!offer) return c.json({ error: 'offer_not_found' }, 404);
    } else {
      const network = await networkRepository.getById(scope_id);
      if (!network) return c.json({ error: 'network_not_found' }, 404);
    }

    const target_connection_id = String(body.target_connection_id ?? '').trim();
    if (!target_connection_id) return c.json({ error: 'invalid_target_connection_id' }, 400);
    const target = await facebookConnectionRepository.getById(target_connection_id);
    if (!target) return c.json({ error: 'connection_not_found' }, 404);
    if (target.type !== 'ad_account') return c.json({ error: 'route_target_must_be_ad_account' }, 400);

    const sale = body.sale_event_name?.trim();
    const click = body.click_event_name?.trim();
    if (sale && !isValidEventName(sale)) return c.json({ error: 'invalid_sale_event_name' }, 400);
    if (click && !isValidEventName(click)) return c.json({ error: 'invalid_click_event_name' }, 400);
    if (!sale && !click) return c.json({ error: 'sale_or_click_required' }, 400);

    const enabled = body.enabled !== false;

    const route = await facebookRouteRepository.upsert({
      route_id: buildFbRouteId(scope_type, scope_id),
      scope_type,
      scope_id,
      target_connection_id,
      sale_event_name: sale || undefined,
      sale_event_dataset_id: body.sale_event_dataset_id?.trim() || undefined,
      click_event_name: click || undefined,
      click_event_dataset_id: body.click_event_dataset_id?.trim() || undefined,
      enabled,
    });
    logger.info('fb_route_set', {
      route_id: route.route_id,
      target_connection_id,
      sale: !!sale,
      click: !!click,
    });
    return c.json(route);
  },

  async getRoute(c: Context) {
    const scope_type = c.req.query('scope_type');
    const scope_id = c.req.query('scope_id');
    if ((scope_type !== 'offer' && scope_type !== 'network') || !scope_id) {
      return c.json({ error: 'invalid_scope' }, 400);
    }
    const route = await facebookRouteRepository.getById(buildFbRouteId(scope_type, scope_id));
    if (!route) return c.json({ route: null });
    return c.json({ route });
  },

  async listRoutes(c: Context) {
    void c;
    const items = await facebookRouteRepository.listAll();
    return c.json({ items });
  },

  async deleteRoute(c: Context) {
    const id = c.req.param('route_id');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const ok = await facebookRouteRepository.delete(id);
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  },

  // ── Uploads ───────────────────────────────────────────────────────
  async listUploadsForSource(c: Context) {
    const source_id = c.req.query('source_id');
    if (!source_id) return c.json({ error: 'invalid_source_id' }, 400);
    const items = await facebookUploadRepository.listForSource(source_id);
    return c.json({ items });
  },

  async retryUpload(c: Context) {
    const conversion_id = c.req.param('conversion_id');
    if (!conversion_id) return c.json({ error: 'invalid_id' }, 400);
    const conv = await conversionRepository.getById(conversion_id);
    if (!conv) return c.json({ error: 'conversion_not_found' }, 404);
    const click = conv.click_id ? await clickRepository.getById(conv.click_id) : null;
    await facebookForwardingService.dispatchConversion({ conversion: conv, click });
    return c.json({ ok: true });
  },

  // Meta-native CSV (different column shape from GAds — identifier_type values
  // and event/dataset columns differ). Same query / streaming pattern.
  async exportUploads(c: Context) {
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!from || !to) return c.json({ error: 'from_and_to_required' }, 400);
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return c.json({ error: 'invalid_date' }, 400);
    }
    if (fromDate.getTime() > toDate.getTime()) {
      return c.json({ error: 'from_after_to' }, 400);
    }

    const kindRaw = c.req.query('kind');
    const statusRaw = c.req.query('status');
    const kind = kindRaw === 'conversion' || kindRaw === 'click' ? kindRaw : undefined;
    const allowedStatuses = ['pending', 'sent', 'partial_failure', 'failed', 'skipped'] as const;
    const status = allowedStatuses.includes(statusRaw as (typeof allowedStatuses)[number])
      ? (statusRaw as (typeof allowedStatuses)[number])
      : undefined;

    const MAX = Number(process.env.META_UPLOADS_EXPORT_MAX ?? 100_000);
    const t0 = Date.now();
    const rows = await facebookUploadRepository.fetchAllForExport({
      from: fromDate,
      to: toDate,
      kind,
      status,
      max: MAX,
    });

    const ENRICH_CHUNK = 300;
    const conversionIds = new Set<string>();
    const clickIds = new Set<string>();
    for (const r of rows) {
      if (r.conversion_id) conversionIds.add(r.conversion_id);
      if (r.click_id) clickIds.add(r.click_id);
    }

    const conversionsById = new Map<string, ConversionRecord>();
    const convIdsArr = Array.from(conversionIds);
    for (let i = 0; i < convIdsArr.length; i += ENRICH_CHUNK) {
      const chunk = convIdsArr.slice(i, i + ENRICH_CHUNK);
      const refs = chunk.map((id) => db().collection(COLLECTIONS.CONVERSIONS).doc(id));
      const docs = await db().getAll(...refs);
      for (const d of docs) {
        if (!d.exists) continue;
        const raw = d.data() as Record<string, unknown>;
        const created_at =
          (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString?.() ??
          (raw.created_at as string | undefined) ??
          '';
        conversionsById.set(d.id, {
          ...(raw as unknown as ConversionRecord),
          conversion_id: d.id,
          created_at,
        });
        const clickFromConv = (raw.click_id as string | undefined) ?? '';
        if (clickFromConv) clickIds.add(clickFromConv);
      }
    }

    const clicksById = new Map<string, ClickRecord>();
    const clickIdsArr = Array.from(clickIds);
    for (let i = 0; i < clickIdsArr.length; i += ENRICH_CHUNK) {
      const chunk = clickIdsArr.slice(i, i + ENRICH_CHUNK);
      const refs = chunk.map((id) => db().collection(COLLECTIONS.CLICKS).doc(id));
      const docs = await db().getAll(...refs);
      for (const d of docs) {
        if (!d.exists) continue;
        const raw = d.data() as Record<string, unknown>;
        clicksById.set(d.id, {
          ...(raw as unknown as ClickRecord),
          click_id: d.id,
        });
      }
    }

    const headers = [
      'created_at',
      'sent_at',
      'kind',
      'status',
      'source_id',
      'conversion_id',
      'click_id',
      'connection_id',
      'ad_account_id',
      'dataset_id',
      'event_name',
      'event_id',
      'identifier_type',
      'identifier_value',
      'attempts',
      'skip_reason',
      'last_error',
      // Conversion join
      'conv_created_at',
      'conv_network_timestamp',
      'conv_payout',
      'conv_currency',
      'conv_status',
      'conv_txn_id',
      'network_id',
      // Click / offer / FB campaign
      'offer_id',
      'aff_id',
      'fb_campaign_id',
      'fb_campaign_source',
      'click_country',
    ];

    const out: string[] = [];
    out.push(headers.map(csvEscape).join(','));
    for (const r of rows) {
      const conv = r.conversion_id ? conversionsById.get(r.conversion_id) : undefined;
      const clickIdForRow = r.click_id ?? conv?.click_id ?? '';
      const click = clickIdForRow ? clicksById.get(clickIdForRow) : undefined;
      const fbCampaign = extractFbCampaign(click);
      const offer_id = conv?.offer_id ?? click?.offer_id ?? '';

      const row: string[] = [
        r.created_at ?? '',
        r.sent_at ?? '',
        r.kind ?? '',
        r.status ?? '',
        r.source_id ?? '',
        r.conversion_id ?? '',
        r.click_id ?? '',
        r.connection_id ?? '',
        r.ad_account_id ?? '',
        r.dataset_id ?? '',
        r.event_name ?? '',
        r.event_id ?? '',
        r.identifier_type ?? '',
        r.identifier_value ?? '',
        typeof r.attempts === 'number' ? String(r.attempts) : '',
        r.skip_reason ?? '',
        r.last_error ?? '',
        conv?.created_at ?? '',
        conv?.network_timestamp ?? '',
        typeof conv?.payout === 'number' ? String(conv.payout) : '',
        conv?.currency ?? '',
        conv?.status ?? '',
        conv?.txn_id ?? '',
        conv?.network_id ?? '',
        offer_id,
        click?.aff_id ?? '',
        fbCampaign?.campaign_id ?? '',
        fbCampaign?.source ?? '',
        click?.country ?? '',
      ];
      out.push(row.map(csvEscape).join(','));
    }

    const body = '﻿' + out.join('\r\n');
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');

    logger.info('fb_uploads_export', {
      rows: rows.length,
      max: MAX,
      truncated: rows.length >= MAX,
      kind: kind ?? 'all',
      status: status ?? 'all',
      enriched_conversions: conversionsById.size,
      enriched_clicks: clicksById.size,
      duration_ms: Date.now() - t0,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    });

    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header(
      'Content-Disposition',
      `attachment; filename="fb_uploads_${stamp}.csv"`
    );
    c.header('X-Row-Count', String(rows.length));
    if (rows.length >= MAX) c.header('X-Export-Truncated', '1');
    return c.body(body);
  },

  // ── Sync ──────────────────────────────────────────────────────────
  async syncCampaigns(c: Context) {
    const body = await c.req.json().catch(() => ({})) as { from?: string; to?: string };
    const fromRaw = body.from ?? '';
    const toRaw = body.to ?? '';
    const now = new Date();
    const from = fromRaw ? new Date(fromRaw) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = toRaw ? new Date(toRaw) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return c.json({ error: 'invalid_date' }, 400);
    }
    if (from.getTime() > to.getTime()) {
      return c.json({ error: 'from_after_to' }, 400);
    }
    try {
      const result = await facebookCampaignSyncService.syncCampaigns({ from, to });
      return c.json({ ok: true, ...result });
    } catch (err) {
      logger.error('sync_facebook_campaigns_failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'internal' }, 500);
    }
  },

  async getSyncState(c: Context) {
    void c;
    const state = await facebookSyncStateRepository.get();
    return c.json(state);
  },

  async saveSyncPrefs(c: Context) {
    const body = (await c.req.json().catch(() => ({}))) as { from?: unknown; to?: unknown };
    const from = typeof body.from === 'string' ? body.from : '';
    const to = typeof body.to === 'string' ? body.to : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return c.json({ error: 'invalid_date' }, 400);
    }
    if (from > to) return c.json({ error: 'from_after_to' }, 400);
    const state = await facebookSyncStateRepository.savePrefs({ from, to });
    return c.json(state);
  },
};
