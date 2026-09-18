import type { Context } from 'hono';
import {
  clickRepository,
  COLLECTIONS,
  conversionRepository,
  db,
  ga4ConnectionRepository,
  ga4SettingsRepository,
  ga4StreamRepository,
  ga4UploadRepository,
} from '../firestore';
import type { Ga4Connection, Ga4Stream, Ga4UploadKind, Ga4UploadStatus } from '../firestore';
import type { ClickRecord, ConversionRecord } from '../types';
import { __campaignFromExtra } from '../services/clickService';
import { csvEscape } from '../utils/csv';
import { ga4OauthService } from '../services/ga4OauthService';
import { ga4AdminClient, Ga4AdminError, USER_DATA_COLLECTION_ACKNOWLEDGEMENT } from '../services/ga4AdminClient';
import { ga4ForwardingService } from '../services/ga4ForwardingService';
import { encryptSecret } from '../utils/crypto';
import { generateConversionId } from '../utils/idGenerator';
import { logger } from '../utils/logger';

// Connections tab → Google Analytics 4.
//
//   1. oauthStart / oauthExchange   sign in with Google (analytics.edit) and
//                                   store the connection
//   2. listStreams                  GA4 web streams that sign-in can manage
//   3. linkStream                   create (or reuse) a Measurement Protocol
//                                   secret on the chosen stream and enable
//                                   conversion forwarding to it
//   4. patch / unlink / test        toggle, event names, remove, validate
//   5. uploads / retry / export     same audit endpoints as Google Ads
//
// API secrets never leave the backend; the dashboard only sees whether a
// stream is linked and enabled.

function adminEmail(c: Context): string {
  return (c.get('admin_email' as never) as string | undefined) ?? '';
}

function publicConnection(conn: Ga4Connection) {
  return {
    connection_id: conn.connection_id,
    google_user_email: conn.google_user_email,
    status: conn.status,
    last_error: conn.last_error,
    created_at: conn.created_at,
    updated_at: conn.updated_at,
  };
}

function publicStream(s: Ga4Stream) {
  return {
    measurement_id: s.measurement_id,
    connection_id: s.connection_id,
    account_name: s.account_name,
    property_id: s.property_id,
    property_name: s.property_name,
    stream_id: s.stream_id,
    stream_name: s.stream_name,
    default_uri: s.default_uri,
    currency_code: s.currency_code,
    time_zone: s.time_zone,
    sale_event_name: s.sale_event_name || 'purchase',
    click_event_name: s.click_event_name,
    enabled: s.enabled,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

const MEASUREMENT_ID_RE = /^G-[A-Z0-9]{4,20}$/;
// GA4 event-name rules: letter first, letters/digits/underscores, <= 40 chars,
// and none of Google's reserved prefixes.
const EVENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
function isValidEventName(name: string): boolean {
  return EVENT_NAME_RE.test(name) && !/^(ga_|google_|firebase_)/i.test(name);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Google revoked / expired the refresh token → flag the connection for re-auth. */
async function markIfAuthFailure(connection_id: string, err: unknown): Promise<void> {
  const msg = errMessage(err);
  if (/invalid_grant|unauthorized|UNAUTHENTICATED|PERMISSION_DENIED/i.test(msg)) {
    await ga4ConnectionRepository.setStatus(connection_id, 'error', msg).catch(() => undefined);
  }
}

export const ga4Controller = {
  async oauthStart(c: Context) {
    try {
      return c.json(await ga4OauthService.buildAuthUrl(adminEmail(c)));
    } catch (err) {
      logger.error('ga4_oauth_start_failed', { error: errMessage(err) });
      return c.json({ error: 'oauth_misconfigured', message: errMessage(err) }, 500);
    }
  },

  async oauthExchange(c: Context) {
    const body = (await c.req.json().catch(() => ({}))) as { code?: string; state?: string };
    if (!body.code || !body.state) return c.json({ error: 'missing_code_or_state' }, 400);
    if (!(await ga4OauthService.verifyState(body.state, adminEmail(c)))) {
      return c.json({ error: 'invalid_state' }, 400);
    }

    let exchanged;
    try {
      exchanged = await ga4OauthService.exchangeCode(body.code);
    } catch (err) {
      logger.error('ga4_oauth_exchange_failed', { error: errMessage(err) });
      return c.json({ error: 'oauth_exchange_failed', message: errMessage(err) }, 400);
    }

    const connection_id = generateConversionId();
    const refresh_token_enc = encryptSecret(exchanged.refresh_token);
    await ga4ConnectionRepository.insert({
      connection_id,
      google_user_email: exchanged.google_user_email,
      refresh_token_enc,
      scopes: exchanged.scopes,
      status: 'active',
    });
    logger.info('ga4_connection_created', { connection_id, google_user_email: exchanged.google_user_email });

    const conn = await ga4ConnectionRepository.get(connection_id);
    return c.json({ connection: conn ? publicConnection(conn) : { connection_id } });
  },

  async listConnections(c: Context) {
    const [connections, streams] = await Promise.all([
      ga4ConnectionRepository.list(),
      ga4StreamRepository.list(),
    ]);
    return c.json({
      items: connections.map((conn) => ({
        ...publicConnection(conn),
        streams: streams.filter((s) => s.connection_id === conn.connection_id).map(publicStream),
      })),
    });
  },

  async deleteConnection(c: Context) {
    const id = c.req.param('id') ?? '';
    const conn = await ga4ConnectionRepository.get(id);
    if (!conn) return c.json({ error: 'not_found' }, 404);
    await ga4ConnectionRepository.delete(id);
    logger.info('ga4_connection_deleted', { connection_id: id });
    return c.json({ ok: true });
  },

  /** Web streams this connection can manage, flagged with their link state. */
  async listStreams(c: Context) {
    const id = c.req.param('id') ?? '';
    const conn = await ga4ConnectionRepository.get(id);
    if (!conn) return c.json({ error: 'not_found' }, 404);
    try {
      const [options, linked] = await Promise.all([
        ga4AdminClient.listWebStreams(conn.refresh_token_enc),
        ga4StreamRepository.list(),
      ]);
      const byMid = new Map(linked.map((s) => [s.measurement_id, s]));
      if (conn.status !== 'active') await ga4ConnectionRepository.setStatus(id, 'active');
      return c.json({
        items: options.map((o) => ({
          ...o,
          linked: byMid.has(o.measurement_id),
          linked_connection_id: byMid.get(o.measurement_id)?.connection_id,
          enabled: byMid.get(o.measurement_id)?.enabled ?? false,
        })),
      });
    } catch (err) {
      await markIfAuthFailure(id, err);
      logger.warn('ga4_list_streams_failed', { connection_id: id, error: errMessage(err) });
      const status = err instanceof Ga4AdminError && err.status >= 400 && err.status < 500 ? 400 : 502;
      return c.json({ error: 'list_streams_failed', message: errMessage(err) }, status);
    }
  },

  async linkStream(c: Context) {
    const id = c.req.param('id') ?? '';
    const body = (await c.req.json().catch(() => ({}))) as {
      measurement_id?: string;
      acknowledge_user_data_collection?: boolean;
    };
    const measurement_id = (body.measurement_id ?? '').trim().toUpperCase();
    if (!MEASUREMENT_ID_RE.test(measurement_id)) return c.json({ error: 'invalid_measurement_id' }, 400);
    if (body.acknowledge_user_data_collection !== true) {
      return c.json({ error: 'acknowledgement_required', acknowledgement: USER_DATA_COLLECTION_ACKNOWLEDGEMENT }, 400);
    }

    const conn = await ga4ConnectionRepository.get(id);
    if (!conn) return c.json({ error: 'not_found' }, 404);

    try {
      // Resolve the stream server-side from the Admin API - never trust the
      // property / stream ids the browser sends.
      const options = await ga4AdminClient.listWebStreams(conn.refresh_token_enc);
      const option = options.find((o) => o.measurement_id === measurement_id);
      if (!option) return c.json({ error: 'stream_not_accessible' }, 404);

      const secret = await ga4AdminClient.ensureMpSecret(conn.refresh_token_enc, option.property_id, option.stream_id);
      // Property currency is the default upload currency (like the Google Ads
      // account currency). Non-fatal: GA4_UPLOAD_CURRENCY / USD cover a failure.
      const settings = await ga4AdminClient
        .getPropertySettings(conn.refresh_token_enc, option.property_id)
        .catch(() => ({ currency_code: undefined, time_zone: undefined }));
      const existing = await ga4StreamRepository.get(measurement_id);
      await ga4StreamRepository.upsert({
        measurement_id,
        connection_id: id,
        account_name: option.account_name,
        property_id: option.property_id,
        property_name: option.property_name,
        stream_id: option.stream_id,
        stream_name: option.stream_name,
        default_uri: option.default_uri,
        api_secret_enc: encryptSecret(secret.secret_value),
        api_secret_name: secret.secret_name,
        currency_code: settings.currency_code,
        time_zone: settings.time_zone,
        // Keep the operator's event choices when a stream is re-linked.
        sale_event_name: existing?.sale_event_name || 'purchase',
        click_event_name: existing?.click_event_name,
        enabled: true,
      });
      logger.info('ga4_stream_linked', {
        connection_id: id,
        measurement_id,
        property_id: option.property_id,
        secret_created: secret.created,
        admin_email: adminEmail(c),
      });
      const saved = await ga4StreamRepository.get(measurement_id);
      return c.json({ stream: saved ? publicStream(saved) : { measurement_id }, secret_created: secret.created });
    } catch (err) {
      await markIfAuthFailure(id, err);
      logger.warn('ga4_link_stream_failed', { connection_id: id, measurement_id, error: errMessage(err) });
      const status = err instanceof Ga4AdminError && err.status >= 400 && err.status < 500 ? 400 : 502;
      return c.json({ error: 'link_stream_failed', message: errMessage(err) }, status);
    }
  },

  // Like Google Ads patchConnection: enable/pause and pick the sale / click
  // events (the GA4 counterpart of conversion actions).
  async patchStream(c: Context) {
    const measurement_id = (c.req.param('measurement_id') ?? '').toUpperCase();
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: unknown;
      sale_event_name?: unknown;
      click_event_name?: unknown;
    };
    const patch: { enabled?: boolean; sale_event_name?: string; click_event_name?: string | null } = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return c.json({ error: 'invalid_enabled' }, 400);
      patch.enabled = body.enabled;
    }
    if (body.sale_event_name !== undefined) {
      const name = typeof body.sale_event_name === 'string' ? body.sale_event_name.trim() : '';
      if (!isValidEventName(name)) return c.json({ error: 'invalid_sale_event_name' }, 400);
      patch.sale_event_name = name;
    }
    if (body.click_event_name !== undefined) {
      const name = typeof body.click_event_name === 'string' ? body.click_event_name.trim() : '';
      if (name && !isValidEventName(name)) return c.json({ error: 'invalid_click_event_name' }, 400);
      patch.click_event_name = name || null;
    }
    if (Object.keys(patch).length === 0) return c.json({ error: 'nothing_to_update' }, 400);
    const stream = await ga4StreamRepository.get(measurement_id);
    if (!stream) return c.json({ error: 'not_found' }, 404);
    await ga4StreamRepository.update(measurement_id, patch);
    logger.info('ga4_stream_updated', { measurement_id, ...patch, admin_email: adminEmail(c) });
    const saved = await ga4StreamRepository.get(measurement_id);
    return c.json({ stream: saved ? publicStream(saved) : { measurement_id } });
  },

  async unlinkStream(c: Context) {
    const measurement_id = (c.req.param('measurement_id') ?? '').toUpperCase();
    const stream = await ga4StreamRepository.get(measurement_id);
    if (!stream) return c.json({ error: 'not_found' }, 404);
    await ga4StreamRepository.delete(measurement_id);
    logger.info('ga4_stream_unlinked', { measurement_id, admin_email: adminEmail(c) });
    return c.json({ ok: true });
  },

  async testStream(c: Context) {
    const measurement_id = (c.req.param('measurement_id') ?? '').toUpperCase();
    try {
      return c.json(await ga4ForwardingService.validateStream(measurement_id));
    } catch (err) {
      return c.json({ ok: false, messages: [errMessage(err)] }, 502);
    }
  },

  // ── Settings ─────────────────────────────────────────────────────────
  async getSettings(c: Context) {
    return c.json(await ga4SettingsRepository.get());
  },

  async patchSettings(c: Context) {
    const body = (await c.req.json().catch(() => ({}))) as { audit_enabled?: unknown };
    if (typeof body.audit_enabled !== 'boolean') return c.json({ error: 'invalid_audit_enabled' }, 400);
    const settings = await ga4SettingsRepository.update({ audit_enabled: body.audit_enabled });
    logger.info('ga4_settings_updated', { audit_enabled: settings.audit_enabled, admin_email: adminEmail(c) });
    return c.json(settings);
  },

  // ── Upload audit (same endpoints as googleAdsController) ─────────────
  // Newest-first page for the GA4 Uploads tab.
  async listUploads(c: Context) {
    const settings = await ga4SettingsRepository.get();
    const parseDate = (v: string | undefined): Date | undefined => {
      if (!v) return undefined;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    const kindRaw = c.req.query('kind');
    const statusRaw = c.req.query('status');
    const allowedStatuses: Ga4UploadStatus[] = ['pending', 'sent', 'failed', 'skipped'];
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 25) || 25, 1), 200);
    const page = await ga4UploadRepository.listPage({
      from: parseDate(c.req.query('from')),
      to: parseDate(c.req.query('to')),
      kind: kindRaw === 'conversion' || kindRaw === 'click' ? kindRaw : undefined,
      status: allowedStatuses.includes(statusRaw as Ga4UploadStatus) ? (statusRaw as Ga4UploadStatus) : undefined,
      limit,
      cursor: c.req.query('cursor'),
    });
    return c.json({ ...page, audit_enabled: settings.audit_enabled });
  },

  async listUploadsForSource(c: Context) {
    const source_id = c.req.query('source_id');
    if (!source_id) return c.json({ error: 'invalid_source_id' }, 400);
    const items = await ga4UploadRepository.listForSource(source_id);
    return c.json({ items });
  },

  async retryUpload(c: Context) {
    const conversion_id = c.req.param('conversion_id');
    if (!conversion_id) return c.json({ error: 'invalid_id' }, 400);
    const conv = await conversionRepository.getById(conversion_id);
    if (!conv) return c.json({ error: 'conversion_not_found' }, 404);
    const click = conv.click_id ? await clickRepository.getById(conv.click_id) : null;
    await ga4ForwardingService.dispatchConversion({ conversion: conv, click });
    return c.json({ ok: true });
  },

  // CSV export of the GA4 upload audit trail - same window rules and
  // conversion / click enrichment as the Google Ads export.
  async exportUploads(c: Context) {
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!from || !to) return c.json({ error: 'from_and_to_required' }, 400);
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return c.json({ error: 'invalid_date' }, 400);
    }
    if (fromDate.getTime() > toDate.getTime()) return c.json({ error: 'from_after_to' }, 400);

    const kindRaw = c.req.query('kind');
    const statusRaw = c.req.query('status');
    const kind: Ga4UploadKind | undefined = kindRaw === 'conversion' || kindRaw === 'click' ? kindRaw : undefined;
    const allowedStatuses: Ga4UploadStatus[] = ['pending', 'sent', 'failed', 'skipped'];
    const status = allowedStatuses.includes(statusRaw as Ga4UploadStatus) ? (statusRaw as Ga4UploadStatus) : undefined;

    const MAX = Number(process.env.GA4_UPLOADS_EXPORT_MAX ?? 100_000);
    const t0 = Date.now();
    const rows = await ga4UploadRepository.fetchAllForExport({ from: fromDate, to: toDate, kind, status, max: MAX });

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
      const refs = convIdsArr.slice(i, i + ENRICH_CHUNK).map((id) => db().collection(COLLECTIONS.CONVERSIONS).doc(id));
      for (const d of await db().getAll(...refs)) {
        if (!d.exists) continue;
        const raw = d.data() as Record<string, unknown>;
        const created_at =
          (raw.created_at as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString?.() ??
          (raw.created_at as string | undefined) ??
          '';
        conversionsById.set(d.id, { ...(raw as unknown as ConversionRecord), conversion_id: d.id, created_at });
        const clickFromConv = (raw.click_id as string | undefined) ?? '';
        if (clickFromConv) clickIds.add(clickFromConv);
      }
    }
    const clicksById = new Map<string, ClickRecord>();
    const clickIdsArr = Array.from(clickIds);
    for (let i = 0; i < clickIdsArr.length; i += ENRICH_CHUNK) {
      const refs = clickIdsArr.slice(i, i + ENRICH_CHUNK).map((id) => db().collection(COLLECTIONS.CLICKS).doc(id));
      for (const d of await db().getAll(...refs)) {
        if (!d.exists) continue;
        clicksById.set(d.id, { ...(d.data() as unknown as ClickRecord), click_id: d.id });
      }
    }

    const headers = [
      'created_at', 'sent_at', 'kind', 'status', 'source_id', 'conversion_id', 'click_id',
      'connection_id', 'measurement_id', 'identifier_type', 'identifier_value', 'session_id',
      'event_name', 'transaction_id', 'value', 'currency', 'event_time',
      'attempts', 'skip_reason', 'last_error',
      'conv_created_at', 'conv_network_timestamp', 'conv_payout', 'conv_currency', 'conv_status', 'conv_txn_id', 'network_id',
      'offer_id', 'aff_id', 'campaign_id', 'click_country',
    ];
    const out: string[] = [headers.map(csvEscape).join(',')];
    for (const r of rows) {
      const conv = r.conversion_id ? conversionsById.get(r.conversion_id) : undefined;
      const clickIdForRow = r.click_id ?? conv?.click_id ?? '';
      const click = clickIdForRow ? clicksById.get(clickIdForRow) : undefined;
      const campaign = __campaignFromExtra(click);
      const row: string[] = [
        r.created_at ?? '', r.sent_at ?? '', r.kind ?? '', r.status ?? '', r.source_id ?? '',
        r.conversion_id ?? '', r.click_id ?? '', r.connection_id ?? '', r.measurement_id ?? '',
        r.identifier_type ?? '', r.identifier_value ?? '', r.session_id ?? '',
        r.event_name ?? '', r.transaction_id ?? '',
        typeof r.value === 'number' ? String(r.value) : '', r.currency ?? '', r.event_time ?? '',
        typeof r.attempts === 'number' ? String(r.attempts) : '', r.skip_reason ?? '', r.last_error ?? '',
        conv?.created_at ?? '', conv?.network_timestamp ?? '',
        typeof conv?.payout === 'number' ? String(conv.payout) : '', conv?.currency ?? '', conv?.status ?? '',
        conv?.txn_id ?? '', conv?.network_id ?? '',
        conv?.offer_id ?? click?.offer_id ?? '', click?.aff_id ?? '', campaign?.campaign_id ?? '', click?.country ?? '',
      ];
      out.push(row.map(csvEscape).join(','));
    }

    // UTF-8 BOM so Excel on Windows renders non-ASCII correctly.
    const body = '\uFEFF' + out.join('\r\n');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    logger.info('ga4_uploads_export', {
      rows: rows.length,
      max: MAX,
      truncated: rows.length >= MAX,
      kind: kind ?? 'all',
      status: status ?? 'all',
      duration_ms: Date.now() - t0,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    });
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="ga4_uploads_${stamp}.csv"`);
    c.header('X-Row-Count', String(rows.length));
    if (rows.length >= MAX) c.header('X-Export-Truncated', '1');
    return c.body(body);
  },
};
