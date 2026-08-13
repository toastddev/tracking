import {
  facebookConnectionRepository,
  facebookRouteRepository,
  facebookUploadRepository,
} from '../firestore';
import { facebookGraphApi, buildGraphUrl, FacebookGraphError } from './facebookGraphClient';
import { decryptSecret } from '../utils/crypto';
import { eventDate } from './eventTime';
import { logger } from '../utils/logger';
import { resolveUploadMoney, normalizeCurrency } from '../utils/fxRates';
import { isMetaUtmSource } from './facebookCampaignExtractor';
import type { ClickRecord, ConversionRecord } from '../types';
import type {
  FacebookConnection,
  FacebookIdentifierType,
  FacebookRoute,
  FacebookUploadKind,
} from '../types/facebookAds';

// Mirror of ./googleAdsForwardingService.ts for Meta CAPI. Differences:
//   - Endpoint: POST {graph}/{ver}/{dataset_id}/events
//   - event_time is a Unix-seconds integer (not a formatted string)
//   - event_id is Meta's dedupe key — we reuse conversion.conversion_id /
//     `click_${click_id}` exactly like GAds order_id
//   - Identifier preference: fbc > fbclid (synth fbc) > fbp
//   - Money: resolveUploadMoney into META_UPLOAD_CURRENCY, else the ad
//     account's own currency
//   - Auth failure heuristic: Meta error code 190 / OAuthException
//
// The public API (`dispatchConversion`, `dispatchClick`, `dispatchConversionsBatch`,
// `forgetConversion`, `forgetClick`) matches the GAds service so call sites in
// clickService / postbackService / affiliateApiSyncService can fan out to both
// with the same signature.

export interface FbDispatchConversionInput {
  conversion: ConversionRecord;
  click: ClickRecord | null;
  postback_timezone?: string;
}
export interface FbDispatchClickInput {
  click: ClickRecord;
}

interface IdentifierPick {
  // 'ip_only' means we have no fbclid/fbc/fbp but the click is provably from
  // Meta (utm_source) AND we have IP + user-agent to send. Meta accepts this
  // as a (lower-match-quality) signal — without it we'd silently drop a
  // meaningful share of Meta traffic on iOS / in-app browsers / Audience
  // Network placements where fbclid gets stripped.
  type: FacebookIdentifierType | 'ip_only';
  value?: string;     // omitted when type='ip_only'
}

// Pick the strongest Meta user-data identifier available. Priority:
//   fbc (cookie)  >  fbclid (synthesise fbc from it)  >  fbp (cookie)
//
// When NONE of those exist, fall back to ip_only mode IF:
//   - utm_source identifies the click as Meta (ig/fb/meta/an/...)
//   - we have IP + user-agent to populate user_data
// Otherwise return null and the dispatcher skips with no_facebook_identifier.
function pickFbIdentifier(click: ClickRecord): IdentifierPick | null {
  const fbc = click.meta_ids?.fbc;
  if (fbc) return { type: 'fbc', value: fbc };

  const fbclid = click.ad_ids?.fbclid;
  if (fbclid) {
    const t = click.created_at ? new Date(click.created_at).getTime() : Date.now();
    const synthesised = `fb.1.${Number.isFinite(t) ? t : Date.now()}.${fbclid}`;
    return { type: 'fbclid', value: synthesised };
  }

  const fbp = click.meta_ids?.fbp;
  if (fbp) return { type: 'fbp', value: fbp };

  // No click-side Meta identifier. Fall back to IP+UA only when we KNOW the
  // click came from Meta (utm_source) AND we have something to populate
  // user_data with. Sending an event with empty user_data fails Meta's
  // server-side validation outright.
  if (isMetaUtmSource(click.extra_params) && click.ip && click.user_agent) {
    return { type: 'ip_only' };
  }

  return null;
}

// Throttled so a single unratable currency logs once per process instead of
// once per conversion — WARN routes to the Telegram alert channel.
const fxWarnCache = new Set<string>();

/**
 * The currency to upload in, in priority order:
 *   1. META_UPLOAD_CURRENCY (explicit operator override)
 *   2. the destination ad account's own currency
 *
 * Mirrors uploadCurrencyFor() in googleAdsForwardingService — matching the ad
 * account's currency means Meta performs no conversion of its own, so Events
 * Manager and the dashboard show identical values.
 */
function uploadCurrencyFor(connection: FacebookConnection): string {
  return (
    normalizeCurrency(process.env.META_UPLOAD_CURRENCY) ??
    normalizeCurrency(connection.currency_code) ??
    'USD'
  );
}

function moneyForUpload(
  conversion: ConversionRecord,
  connection: FacebookConnection
): { value: number; currency_code: string } {
  const target = uploadCurrencyFor(connection);
  const money = resolveUploadMoney(conversion.payout ?? 0, conversion.currency, target);

  if (money.ok) {
    if (money.converted) {
      logger.info('fb_conversion_value_converted', {
        conversion_id: conversion.conversion_id,
        from_currency: conversion.currency,
        to_currency: money.currency,
        from_value: conversion.payout ?? 0,
        to_value: money.value,
        connection_id: connection.connection_id,
      });
    }
    return { value: money.value, currency_code: money.currency };
  }

  // No rate for this pair — send the untouched source amount under its TRUE
  // source currency and let Meta convert. Approximate, but never mislabelled.
  const key = `fb_fx:${money.currency}->${target}`;
  if (!fxWarnCache.has(key)) {
    fxWarnCache.add(key);
    logger.warn('fb_conversion_value_fx_missing', {
      from_currency: money.currency,
      to_currency: target,
      connection_id: connection.connection_id,
      effect: 'uploaded in source currency; Meta will convert at its own daily rate',
      hint: `Add ${money.currency} to FX_RATES in src/utils/fxRates.constants.ts so the dashboard and Meta agree.`,
    });
  }
  return { value: money.value, currency_code: money.currency };
}

// Re-interpret network_timestamp in the network's reported timezone before
// computing the Unix-seconds `event_time`. Mirrors the rationale in the GAds
// forwarder's adjustEventDateForGads(): networks like MaxBounty (EST) send
// timestamps without TZ info; JS parses them as UTC; without correction we
// produce an event_time hours behind the click and Meta may reject as
// "event_time precedes click".
function adjustEventDateForFb(conversion: ConversionRecord, postbackTimezone?: string): Date {
  const fallback = eventDate(conversion);
  if (!postbackTimezone || !conversion.network_timestamp) return fallback;
  const networkTs = new Date(conversion.network_timestamp);
  if (Number.isNaN(networkTs.getTime())) return fallback;
  if (fallback.getTime() !== networkTs.getTime()) return fallback;
  try {
    const utcStr = networkTs.toLocaleString('en-US', { timeZone: 'UTC' });
    const tzStr = networkTs.toLocaleString('en-US', { timeZone: postbackTimezone });
    const utcMs = new Date(utcStr).getTime();
    const tzMs = new Date(tzStr).getTime();
    const offsetMs = tzMs - utcMs;
    return new Date(networkTs.getTime() - offsetMs);
  } catch {
    return fallback;
  }
}

interface UploadContext {
  kind: FacebookUploadKind;
  source_id: string;
  conversion_id?: string;
  click_id?: string;
  identifier: IdentifierPick;
  event_name: string;
  dataset_id: string;
  event_id: string;                  // Meta dedupe key
  event_time_unix: number;           // Unix seconds
  value?: number;                    // omitted on click events
  currency_code?: string;            // omitted on click events
  ip?: string;
  user_agent?: string;
}

function buildCapiPayload(ctx: UploadContext): { data: Record<string, unknown>[] } {
  const userData: Record<string, unknown> = {};

  // Click-side identifier — omitted for ip_only mode (Meta then attributes
  // via IP + UA only, lower match quality but still attributed).
  if (ctx.identifier.type === 'fbc' && ctx.identifier.value) {
    userData.fbc = ctx.identifier.value;
  } else if (ctx.identifier.type === 'fbclid' && ctx.identifier.value) {
    userData.fbc = ctx.identifier.value;   // we synthesised an fbc from fbclid
  } else if (ctx.identifier.type === 'fbp' && ctx.identifier.value) {
    userData.fbp = ctx.identifier.value;
  }
  // type === 'ip_only' — no fbc/fbp field, just rely on IP+UA below.

  if (ctx.ip) userData.client_ip_address = ctx.ip;
  if (ctx.user_agent) userData.client_user_agent = ctx.user_agent;

  const customData: Record<string, unknown> = { order_id: ctx.event_id };
  if (typeof ctx.value === 'number') customData.value = ctx.value;
  if (ctx.currency_code) customData.currency = ctx.currency_code;

  return {
    data: [
      {
        event_name: ctx.event_name,
        event_time: ctx.event_time_unix,
        event_id: ctx.event_id,
        action_source: 'website',
        user_data: userData,
        custom_data: customData,
      },
    ],
  };
}

async function postCapi(
  connection: FacebookConnection,
  ctx: UploadContext
): Promise<{ ok: true; partial?: string; response: unknown } | { ok: false; error: string; httpStatus?: number; code?: number }> {
  const token = decryptSecret(connection.access_token_enc);
  const url = buildGraphUrl(`/${ctx.dataset_id}/events`, { access_token: token });
  const body = buildCapiPayload(ctx);
  try {
    const response = await facebookGraphApi.post<{ events_received?: number; messages?: unknown[]; fbtrace_id?: string }>(url, body);
    // Meta returns 200 + body{ events_received: N }. If events_received is 0
    // when we sent 1, treat it as a partial_failure for the audit row.
    const partial =
      typeof response?.events_received === 'number' && response.events_received < 1
        ? `events_received=${response.events_received}; messages=${JSON.stringify(response.messages ?? [])}`
        : undefined;
    return { ok: true, partial, response };
  } catch (err) {
    if (err instanceof FacebookGraphError) {
      return { ok: false, error: err.message, httpStatus: err.httpStatus, code: err.code };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isAuthClassError(args: { code?: number; error: string }): boolean {
  if (args.code === 190) return true;
  if (args.code === 102 || args.code === 200 || args.code === 2500) return true;
  return /OAuthException|access_token|expired|permission/i.test(args.error);
}

async function persistAttempt(args: {
  ctx: UploadContext;
  connection: FacebookConnection;
  ad_account_id?: string;
  result: Awaited<ReturnType<typeof postCapi>>;
}): Promise<void> {
  const { ctx, connection, result } = args;
  if (!result.ok) {
    await facebookUploadRepository.record({
      kind: ctx.kind,
      source_id: ctx.source_id,
      conversion_id: ctx.conversion_id,
      click_id: ctx.click_id,
      connection_id: connection.connection_id,
      ad_account_id: args.ad_account_id ?? connection.ad_account_id,
      dataset_id: ctx.dataset_id,
      event_name: ctx.event_name,
      event_id: ctx.event_id,
      identifier_type: ctx.identifier.type,
      identifier_value: ctx.identifier.value,
      status: 'failed',
      attempts: 1,
      last_error: result.error.slice(0, 4000),
    });
    const isAuth = isAuthClassError({ code: result.code, error: result.error });
    if (isAuth) {
      await facebookConnectionRepository.update(connection.connection_id, {
        status: 'error',
        last_error: result.error.slice(0, 4000),
      });
    }
    logger[isAuth ? 'critical' : 'error']('fb_upload_failed', {
      kind: ctx.kind, source_id: ctx.source_id,
      connection_id: connection.connection_id,
      auth_error: isAuth,
      error: result.error,
    });
    return;
  }
  await facebookUploadRepository.record({
    kind: ctx.kind,
    source_id: ctx.source_id,
    conversion_id: ctx.conversion_id,
    click_id: ctx.click_id,
    connection_id: connection.connection_id,
    ad_account_id: args.ad_account_id ?? connection.ad_account_id,
    dataset_id: ctx.dataset_id,
    event_name: ctx.event_name,
    event_id: ctx.event_id,
    identifier_type: ctx.identifier.type,
    identifier_value: ctx.identifier.value,
    status: result.partial ? 'partial_failure' : 'sent',
    attempts: 1,
    sent_at: new Date().toISOString(),
    last_error: result.partial,
    meta_response: result.response as Record<string, unknown> | undefined,
  });
  if (result.partial) {
    logger.warn('fb_upload_partial_failure', {
      kind: ctx.kind, source_id: ctx.source_id,
      connection_id: connection.connection_id,
      error: result.partial,
    });
  } else {
    logger.info('fb_upload_sent', {
      kind: ctx.kind, source_id: ctx.source_id,
      connection_id: connection.connection_id,
      identifier_type: ctx.identifier.type,
    });
  }
}

async function recordSkip(args: {
  kind: FacebookUploadKind;
  source_id: string;
  conversion_id?: string;
  click_id?: string;
  reason: string;
  connection_id?: string;
  ad_account_id?: string;
  dataset_id?: string;
  event_name?: string;
  identifier?: IdentifierPick;
}): Promise<void> {
  await facebookUploadRepository.record({
    kind: args.kind,
    source_id: args.source_id,
    conversion_id: args.conversion_id,
    click_id: args.click_id,
    connection_id: args.connection_id,
    ad_account_id: args.ad_account_id,
    dataset_id: args.dataset_id,
    event_name: args.event_name,
    identifier_type: args.identifier?.type,
    identifier_value: args.identifier?.value,
    status: 'skipped',
    attempts: 0,
    skip_reason: args.reason,
  });
  logger.info('fb_upload_skipped', {
    kind: args.kind,
    source_id: args.source_id,
    reason: args.reason,
  });
}

// Pick the dataset + event_name pair to push to, given a connection + an
// optional route override.
function resolveSaleTarget(connection: FacebookConnection, route?: FacebookRoute | null) {
  const event_name = route?.sale_event_name || connection.sale_event_name;
  const dataset_id =
    route?.sale_event_dataset_id ||
    connection.sale_event_dataset_id ||
    connection.dataset_id;
  return event_name && dataset_id ? { event_name, dataset_id } : null;
}

function resolveClickTarget(connection: FacebookConnection, route?: FacebookRoute | null) {
  const event_name = route?.click_event_name || connection.click_event_name;
  const dataset_id =
    route?.click_event_dataset_id ||
    connection.click_event_dataset_id ||
    connection.dataset_id;
  return event_name && dataset_id ? { event_name, dataset_id } : null;
}

export const facebookForwardingService = {
  async dispatchConversion(input: FbDispatchConversionInput): Promise<void> {
    const { conversion, click } = input;
    if (!conversion.verified || !click) {
      await recordSkip({
        kind: 'conversion',
        source_id: conversion.conversion_id,
        conversion_id: conversion.conversion_id,
        reason: 'unverified_or_no_click',
      });
      return;
    }
    const identifier = pickFbIdentifier(click);
    if (!identifier) {
      await recordSkip({
        kind: 'conversion',
        source_id: conversion.conversion_id,
        conversion_id: conversion.conversion_id,
        reason: 'no_facebook_identifier',
      });
      return;
    }

    const eventTimeSec = Math.floor(
      adjustEventDateForFb(conversion, input.postback_timezone).getTime() / 1000
    );

    let dispatched = 0;

    // 1. Cross-account: every active 'business' connection that has a sale
    //    event configured. Mirrors GAds MCC fan-out.
    const businessConns = await facebookConnectionRepository.listByType('business');
    for (const conn of businessConns) {
      if (conn.status !== 'active' && conn.status !== 'expiring') continue;
      const target = resolveSaleTarget(conn);
      if (!target) continue;
      const money = moneyForUpload(conversion, conn);
      const ctx: UploadContext = {
        kind: 'conversion',
        source_id: conversion.conversion_id,
        conversion_id: conversion.conversion_id,
        identifier,
        event_name: target.event_name,
        dataset_id: target.dataset_id,
        event_id: conversion.conversion_id,
        event_time_unix: eventTimeSec,
        value: money.value,
        currency_code: money.currency_code,
        ip: click.ip,
        user_agent: click.user_agent,
      };
      const result = await postCapi(conn, ctx);
      await persistAttempt({ ctx, connection: conn, result });
      dispatched++;
    }

    // 2. Per-offer/network route → an ad_account connection.
    const route = await facebookRouteRepository.resolveForConversion(conversion.offer_id, conversion.network_id);
    if (route && route.sale_event_name) {
      const targetConn = await facebookConnectionRepository.getById(route.target_connection_id);
      if (!targetConn || (targetConn.status !== 'active' && targetConn.status !== 'expiring')) {
        await recordSkip({
          kind: 'conversion',
          source_id: conversion.conversion_id,
          conversion_id: conversion.conversion_id,
          reason: targetConn ? 'connection_not_active' : 'destination_missing',
          identifier,
          connection_id: route.target_connection_id,
          event_name: route.sale_event_name,
          dataset_id: route.sale_event_dataset_id,
        });
      } else {
        const target = resolveSaleTarget(targetConn, route);
        if (target) {
          const money = moneyForUpload(conversion, targetConn);
          const ctx: UploadContext = {
            kind: 'conversion',
            source_id: conversion.conversion_id,
            conversion_id: conversion.conversion_id,
            identifier,
            event_name: target.event_name,
            dataset_id: target.dataset_id,
            event_id: conversion.conversion_id,
            event_time_unix: eventTimeSec,
            value: money.value,
            currency_code: money.currency_code,
            ip: click.ip,
            user_agent: click.user_agent,
          };
          const result = await postCapi(targetConn, ctx);
          await persistAttempt({ ctx, connection: targetConn, result });
          dispatched++;
        }
      }
    }

    if (dispatched === 0) {
      await recordSkip({
        kind: 'conversion',
        source_id: conversion.conversion_id,
        conversion_id: conversion.conversion_id,
        reason: 'no_destination_configured',
        identifier,
      });
    }
  },

  // Only fired when the click has a Facebook identifier. Non-FB clicks
  // short-circuit at the call site (clickService) so we don't even log noise.
  async dispatchClick(input: FbDispatchClickInput): Promise<void> {
    const click = input.click;
    const identifier = pickFbIdentifier(click);
    if (!identifier) return;

    const eventTimeSec = Math.floor(new Date(click.created_at).getTime() / 1000);

    let dispatched = 0;

    const businessConns = await facebookConnectionRepository.listByType('business');
    for (const conn of businessConns) {
      if (conn.status !== 'active' && conn.status !== 'expiring') continue;
      const target = resolveClickTarget(conn);
      if (!target) continue;
      const ctx: UploadContext = {
        kind: 'click',
        source_id: click.click_id,
        click_id: click.click_id,
        identifier,
        event_name: target.event_name,
        dataset_id: target.dataset_id,
        event_id: `click_${click.click_id}`,
        event_time_unix: eventTimeSec,
        ip: click.ip,
        user_agent: click.user_agent,
      };
      const result = await postCapi(conn, ctx);
      await persistAttempt({ ctx, connection: conn, result });
      dispatched++;
    }

    const route = await facebookRouteRepository.resolveForOffer(click.offer_id);
    if (route && route.click_event_name) {
      const targetConn = await facebookConnectionRepository.getById(route.target_connection_id);
      if (targetConn && (targetConn.status === 'active' || targetConn.status === 'expiring')) {
        const target = resolveClickTarget(targetConn, route);
        if (target) {
          const ctx: UploadContext = {
            kind: 'click',
            source_id: click.click_id,
            click_id: click.click_id,
            identifier,
            event_name: target.event_name,
            dataset_id: target.dataset_id,
            event_id: `click_${click.click_id}`,
            event_time_unix: eventTimeSec,
            ip: click.ip,
            user_agent: click.user_agent,
          };
          const result = await postCapi(targetConn, ctx);
          await persistAttempt({ ctx, connection: targetConn, result });
          dispatched++;
        }
      }
    }

    if (dispatched === 0) {
      logger.info('fb_click_no_destination', { click_id: click.click_id });
    }
  },

  // Affiliate API sync path — groups conversions by destination connection
  // and fires ONE /events POST per connection (up to META_BATCH_MAX_EVENTS).
  async dispatchConversionsBatch(
    inputs: FbDispatchConversionInput[]
  ): Promise<{ sent: number; skipped: number; failed: number; errors: string[] }> {
    const stats = { sent: 0, skipped: 0, failed: 0, errors: [] as string[] };
    if (inputs.length === 0) return stats;

    const MAX_PER_BATCH = Math.max(1, Math.min(1000, Number(process.env.META_BATCH_MAX_EVENTS ?? 1000)));

    type Eligible = {
      conversion: ConversionRecord;
      click: ClickRecord;
      identifier: IdentifierPick;
      postback_timezone?: string;
      event_time_unix: number;
    };
    const eligible: Eligible[] = [];
    for (const { conversion, click, postback_timezone } of inputs) {
      if (!conversion.verified || !click) { stats.skipped++; continue; }
      const identifier = pickFbIdentifier(click);
      if (!identifier) { stats.skipped++; continue; }
      const event_time_unix = Math.floor(
        adjustEventDateForFb(conversion, postback_timezone).getTime() / 1000
      );
      eligible.push({ conversion, click, identifier, postback_timezone, event_time_unix });
    }
    if (eligible.length === 0) return stats;

    const businessConns = await facebookConnectionRepository.listByType('business');
    const activeBusiness = businessConns.filter(
      (c) => (c.status === 'active' || c.status === 'expiring') && (c.sale_event_name && (c.sale_event_dataset_id || c.dataset_id))
    );

    const routeCache = new Map<string, FacebookRoute | null>();
    const connCache = new Map<string, FacebookConnection | null>();

    async function resolveRoute(offer_id?: string, network_id?: string): Promise<{ route: FacebookRoute; conn: FacebookConnection } | null> {
      const key = `${offer_id ?? ''}|${network_id ?? ''}`;
      if (!routeCache.has(key)) {
        const r = await facebookRouteRepository.resolveForConversion(offer_id, network_id ?? '');
        routeCache.set(key, r);
      }
      const route = routeCache.get(key)!;
      if (!route || !route.sale_event_name) return null;
      if (!connCache.has(route.target_connection_id)) {
        const conn = await facebookConnectionRepository.getById(route.target_connection_id);
        connCache.set(
          route.target_connection_id,
          conn && (conn.status === 'active' || conn.status === 'expiring') ? conn : null
        );
      }
      const conn = connCache.get(route.target_connection_id)!;
      if (!conn) return null;
      return { route, conn };
    }

    type ConnBatch = {
      connection: FacebookConnection;
      // Each entry is a (dataset, event_name) grouping — Meta requires one
      // dataset per /events POST, so we sub-group inside the connection too.
      groups: Map<string, {
        dataset_id: string;
        event_name: string;
        items: Array<{ payload: Record<string, unknown>; eligible: Eligible }>;
      }>;
    };
    const batches = new Map<string, ConnBatch>();

    function ensureBatch(conn: FacebookConnection): ConnBatch {
      let b = batches.get(conn.connection_id);
      if (!b) {
        b = { connection: conn, groups: new Map() };
        batches.set(conn.connection_id, b);
      }
      return b;
    }

    function pushToGroup(
      batch: ConnBatch,
      dataset_id: string,
      event_name: string,
      payload: Record<string, unknown>,
      eligible: Eligible
    ): void {
      const key = `${dataset_id}|${event_name}`;
      let g = batch.groups.get(key);
      if (!g) {
        g = { dataset_id, event_name, items: [] };
        batch.groups.set(key, g);
      }
      g.items.push({ payload, eligible });
    }

    function buildEvent(
      item: Eligible,
      conn: FacebookConnection,
      event_name: string,
      event_time_unix: number
    ): Record<string, unknown> {
      const money = moneyForUpload(item.conversion, conn);
      const userData: Record<string, unknown> = {};
      // Mirror buildCapiPayload's per-identifier-type field mapping. ip_only
      // contributes nothing here — Meta attributes via IP+UA below.
      if (item.identifier.type === 'fbc' && item.identifier.value) {
        userData.fbc = item.identifier.value;
      } else if (item.identifier.type === 'fbclid' && item.identifier.value) {
        userData.fbc = item.identifier.value;
      } else if (item.identifier.type === 'fbp' && item.identifier.value) {
        userData.fbp = item.identifier.value;
      }
      if (item.click.ip) userData.client_ip_address = item.click.ip;
      if (item.click.user_agent) userData.client_user_agent = item.click.user_agent;
      return {
        event_name,
        event_time: event_time_unix,
        event_id: item.conversion.conversion_id,
        action_source: 'website',
        user_data: userData,
        custom_data: {
          value: money.value,
          currency: money.currency_code,
          order_id: item.conversion.conversion_id,
        },
      };
    }

    for (const item of eligible) {
      // 1. Cross-account business connections
      for (const conn of activeBusiness) {
        const target = resolveSaleTarget(conn);
        if (!target) continue;
        pushToGroup(
          ensureBatch(conn),
          target.dataset_id,
          target.event_name,
          buildEvent(item, conn, target.event_name, item.event_time_unix),
          item
        );
      }

      // 2. Per-offer/network route
      const resolved = await resolveRoute(item.conversion.offer_id, item.conversion.network_id);
      if (resolved) {
        const target = resolveSaleTarget(resolved.conn, resolved.route);
        if (target) {
          pushToGroup(
            ensureBatch(resolved.conn),
            target.dataset_id,
            target.event_name,
            buildEvent(item, resolved.conn, target.event_name, item.event_time_unix),
            item
          );
        }
      }
    }

    if (batches.size === 0) {
      stats.skipped += eligible.length;
      logger.info('fb_batch_no_destinations', { count: eligible.length });
      return stats;
    }

    for (const [, batch] of batches) {
      const { connection, groups } = batch;
      const token = decryptSecret(connection.access_token_enc);

      for (const [, group] of groups) {
        // Chunk by MAX_PER_BATCH to respect Meta's per-request cap.
        for (let i = 0; i < group.items.length; i += MAX_PER_BATCH) {
          const slice = group.items.slice(i, i + MAX_PER_BATCH);
          const url = buildGraphUrl(`/${group.dataset_id}/events`, { access_token: token });
          const body = { data: slice.map((s) => s.payload) };

          try {
            const response = await facebookGraphApi.post<{ events_received?: number; messages?: unknown[]; fbtrace_id?: string }>(url, body);
            const received = typeof response?.events_received === 'number' ? response.events_received : slice.length;
            const partial = received < slice.length
              ? `events_received=${received} of ${slice.length}; messages=${JSON.stringify(response.messages ?? [])}`
              : undefined;

            if (partial) {
              stats.sent += slice.length;
              stats.errors.push(`partial[${connection.connection_id}]: ${partial.slice(0, 500)}`);
              logger.warn('fb_batch_partial_failure', {
                connection_id: connection.connection_id,
                count: slice.length,
                error: partial.slice(0, 500),
              });
            } else {
              stats.sent += slice.length;
              logger.info('fb_batch_sent', {
                connection_id: connection.connection_id,
                count: slice.length,
                dataset_id: group.dataset_id,
                event_name: group.event_name,
              });
            }

            for (const s of slice) {
              facebookUploadRepository
                .record({
                  kind: 'conversion',
                  source_id: s.eligible.conversion.conversion_id,
                  conversion_id: s.eligible.conversion.conversion_id,
                  click_id: s.eligible.click.click_id,
                  connection_id: connection.connection_id,
                  ad_account_id: connection.ad_account_id,
                  dataset_id: group.dataset_id,
                  event_name: group.event_name,
                  event_id: s.eligible.conversion.conversion_id,
                  identifier_type: s.eligible.identifier.type,
                  identifier_value: s.eligible.identifier.value,
                  status: partial ? 'partial_failure' : 'sent',
                  attempts: 1,
                  sent_at: new Date().toISOString(),
                  last_error: partial,
                })
                .catch(() => {});
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const code = err instanceof FacebookGraphError ? err.code : undefined;
            stats.failed += slice.length;
            stats.errors.push(`failed[${connection.connection_id}]: ${errMsg.slice(0, 500)}`);
            const isAuth = isAuthClassError({ code, error: errMsg });
            logger[isAuth ? 'critical' : 'error']('fb_batch_failed', {
              connection_id: connection.connection_id,
              count: slice.length,
              auth_error: isAuth,
              error: errMsg,
            });
            if (isAuth) {
              await facebookConnectionRepository
                .update(connection.connection_id, {
                  status: 'error',
                  last_error: errMsg.slice(0, 4000),
                })
                .catch(() => {});
            }
            for (const s of slice) {
              facebookUploadRepository
                .record({
                  kind: 'conversion',
                  source_id: s.eligible.conversion.conversion_id,
                  conversion_id: s.eligible.conversion.conversion_id,
                  click_id: s.eligible.click.click_id,
                  connection_id: connection.connection_id,
                  ad_account_id: connection.ad_account_id,
                  dataset_id: group.dataset_id,
                  event_name: group.event_name,
                  event_id: s.eligible.conversion.conversion_id,
                  identifier_type: s.eligible.identifier.type,
                  identifier_value: s.eligible.identifier.value,
                  status: 'failed',
                  attempts: 1,
                  last_error: errMsg.slice(0, 4000),
                })
                .catch(() => {});
            }
          }
        }
      }
    }

    return stats;
  },

  // Fire-and-forget wrappers — never let an exception escape into the caller's
  // request scope.
  forgetConversion(input: FbDispatchConversionInput): void {
    void this.dispatchConversion(input).catch((err) => {
      logger.error('fb_dispatch_conversion_uncaught', {
        conversion_id: input.conversion.conversion_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  },

  forgetClick(input: FbDispatchClickInput): void {
    void this.dispatchClick(input).catch((err) => {
      logger.error('fb_dispatch_click_uncaught', {
        click_id: input.click.click_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  },
};
