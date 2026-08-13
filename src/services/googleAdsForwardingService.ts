import { buildCustomer } from './googleAdsClient';
import { eventDate } from './eventTime';
import {
  googleAdsConnectionRepository,
  googleAdsRouteRepository,
  googleAdsUploadRepository,
} from '../firestore';
import { logger } from '../utils/logger';
import { resolveUploadMoney, normalizeCurrency } from '../utils/fxRates';
import type { ClickRecord, ConversionRecord } from '../types';
import type {
  GoogleAdsConnection,
  GoogleAdsIdentifierType,
  GoogleAdsRoute,
  GoogleAdsUploadKind,
} from '../types/googleAds';

export interface DispatchConversionInput {
  conversion: ConversionRecord;
  click: ClickRecord | null;
  /** IANA timezone of the network that produced this conversion (e.g. 'America/New_York').
   *  When set, the forwarding service re-interprets network_timestamp from
   *  this timezone to produce a correct UTC date for Google Ads. */
  postback_timezone?: string;
}
export interface DispatchClickInput {
  click: ClickRecord;
}

interface IdentifierPick {
  type: GoogleAdsIdentifierType;
  value: string;
}

function pickIdentifier(adIds: ClickRecord['ad_ids'] | undefined): IdentifierPick | null {
  const ad = adIds ?? {};
  if (ad.gclid) return { type: 'gclid', value: ad.gclid };
  if (ad.gbraid) return { type: 'gbraid', value: ad.gbraid };
  if (ad.wbraid) return { type: 'wbraid', value: ad.wbraid };
  return null;
}

// "yyyy-mm-dd HH:mm:ss+|-HH:mm" in the destination account's timezone.
function formatGoogleAdsDateTime(
  iso: string,
  timeZone: string,
  rawNetworkTimestamp?: string,
  postbackTimezone?: string,
  convertTzToAccount?: boolean
): string {
  // Default behavior: pass original time with postback timezone offset
  if (!convertTzToAccount && postbackTimezone && rawNetworkTimestamp) {
    const networkTs = new Date(rawNetworkTimestamp);
    if (!Number.isNaN(networkTs.getTime())) {
      const trueUtcMs = new Date(iso).getTime();
      const offsetMin = Math.round(
        (new Date(new Date(trueUtcMs).toLocaleString('en-US', { timeZone: postbackTimezone })).getTime() -
         new Date(new Date(trueUtcMs).toLocaleString('en-US', { timeZone: 'UTC' })).getTime()) /
         60000
      );
      
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
      const parts = Object.fromEntries(fmt.formatToParts(networkTs).map((p) => [p.type, p.value]));
      const date = `${parts.year}-${parts.month}-${parts.day}`;
      const time = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}`;

      const sign = offsetMin >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMin);
      const oh = String(Math.floor(abs / 60)).padStart(2, '0');
      const om = String(abs % 60).padStart(2, '0');
      return `${date} ${time}${sign}${oh}:${om}`;
    }
  }

  const d = iso ? new Date(iso) : new Date();
  const tz = timeZone || 'UTC';

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}`;

  const tzOffsetMin = Math.round(
    (new Date(d.toLocaleString('en-US', { timeZone: tz })).getTime() -
      new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()) /
      60000
  );
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(tzOffsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${date} ${time}${sign}${oh}:${om}`;
}

/**
 * Re-interprets a network_timestamp that was sent in a non-UTC timezone.
 *
 * Problem: networks like MaxBounty (EST) or AdMedia (PST) send timestamps
 * without timezone info (e.g. "2026-05-09T17:35:00"). JavaScript's `new Date()`
 * parses these as UTC, but the actual wall-clock time is in the network's local
 * timezone. When we forward this to Google Ads (whose account is in IST), the
 * conversion_date_time ends up hours behind the real event, causing Google to
 * reject it with "timestamp precedes the click".
 *
 * Fix: if postback_timezone is set, calculate the UTC offset for that timezone
 * at the given time and shift the date accordingly.
 *
 * This helper is ONLY used for the Google Ads upload path — it does NOT affect
 * conversion recording, report bucketing, or any other system.
 */
function adjustEventDateForGads(
  conversion: ConversionRecord,
  postbackTimezone?: string
): Date {
  const fallback = eventDate(conversion);
  if (!postbackTimezone || !conversion.network_timestamp) return fallback;

  // eventDate() already does sanity-check and may return created_at instead.
  // We only adjust if eventDate() actually chose the network_timestamp.
  const networkTs = new Date(conversion.network_timestamp);
  if (Number.isNaN(networkTs.getTime())) return fallback;
  if (fallback.getTime() !== networkTs.getTime()) return fallback;

  // The network_timestamp string was parsed as UTC by `new Date()`, but the
  // actual wall-clock time is in postbackTimezone. Calculate the offset
  // between UTC and postbackTimezone at this instant, then shift.
  try {
    // Get what "UTC" looks like in the network's timezone at this moment.
    const utcStr = networkTs.toLocaleString('en-US', { timeZone: 'UTC' });
    const tzStr = networkTs.toLocaleString('en-US', { timeZone: postbackTimezone });
    const utcMs = new Date(utcStr).getTime();
    const tzMs = new Date(tzStr).getTime();
    const offsetMs = tzMs - utcMs; // positive = timezone is ahead of UTC
    // The raw timestamp was in the network's local time but parsed as UTC.
    // Subtract the offset to get the true UTC time.
    return new Date(networkTs.getTime() - offsetMs);
  } catch {
    // Invalid timezone — fall back to unadjusted eventDate
    return fallback;
  }
}

interface UploadContext {
  kind: GoogleAdsUploadKind;
  source_id: string;
  conversion_id?: string;
  click_id?: string;
  identifier: IdentifierPick;
  conversion_action_resource: string;
  // payload values that drive Google Ads ranking
  conversion_value: number;
  currency_code?: string;
  conversion_date_time_iso: string;       // when the original event happened
  raw_network_timestamp?: string;
  postback_timezone?: string;
  // idempotency: same (kind, source_id, connection) repeated calls should
  // upload with the same order_id
  order_id: string;
}

// Throttled so a single unratable currency logs once per process instead of
// once per conversion — WARN routes to the Telegram alert channel.
const fxWarnCache = new Set<string>();

/**
 * The currency to upload in, in priority order:
 *   1. GOOGLE_ADS_UPLOAD_CURRENCY (explicit operator override)
 *   2. the destination account's own currency
 *
 * Preferring the account's currency means Google performs no conversion of its
 * own, so the "Conv. value" column matches the dashboard exactly rather than
 * drifting with Google's daily rate.
 */
function uploadCurrencyFor(connection: GoogleAdsConnection): string {
  return (
    normalizeCurrency(process.env.GOOGLE_ADS_UPLOAD_CURRENCY) ??
    normalizeCurrency(connection.currency_code) ??
    'USD'
  );
}

function moneyForUpload(
  conversion: ConversionRecord,
  connection: GoogleAdsConnection
): { conversion_value: number; currency_code: string } {
  const targetCurrency = uploadCurrencyFor(connection);
  const money = resolveUploadMoney(conversion.payout ?? 0, conversion.currency, targetCurrency);

  if (money.ok) {
    if (money.converted) {
      logger.info('gads_conversion_value_converted', {
        conversion_id: conversion.conversion_id,
        from_currency: conversion.currency,
        to_currency: money.currency,
        from_value: conversion.payout ?? 0,
        to_value: money.value,
        connection_id: connection.connection_id,
      });
    }
    return { conversion_value: money.value, currency_code: money.currency };
  }

  // No rate for this pair. Upload the untouched source amount labelled with its
  // TRUE source currency and let Google apply its own daily rate — approximate,
  // but never mislabelled. The one thing we must never do is ship a value
  // scaled to one currency under another currency's code; Google can't detect
  // that and silently reports a wrong number.
  const key = `gads_fx:${money.currency}->${targetCurrency}`;
  if (!fxWarnCache.has(key)) {
    fxWarnCache.add(key);
    logger.warn('gads_conversion_value_fx_missing', {
      from_currency: money.currency,
      to_currency: targetCurrency,
      connection_id: connection.connection_id,
      effect: 'uploaded in source currency; Google Ads will convert at its own daily rate',
      hint: `Add ${money.currency} to FX_RATES in src/utils/fxRates.constants.ts so the dashboard and Google Ads agree.`,
    });
  }
  return { conversion_value: money.value, currency_code: money.currency };
}

async function callGoogleAds(
  connection: GoogleAdsConnection,
  ctx: UploadContext
): Promise<{ ok: true; partial?: string; response: unknown } | { ok: false; error: string }> {
  const customer = buildCustomer({
    connection,
    customer_id: connection.customer_id,
    login_customer_id: connection.manager_customer_id,
  });
  const cc: Record<string, unknown> = {
    conversion_action: ctx.conversion_action_resource,
    conversion_date_time: formatGoogleAdsDateTime(
      ctx.conversion_date_time_iso,
      connection.time_zone || 'UTC',
      ctx.raw_network_timestamp,
      ctx.postback_timezone,
      connection.convert_tz_to_account
    ),
    conversion_value: ctx.conversion_value,
    // Always a valid ISO-4217 code — Google rejects the row otherwise, and a
    // rejection only ever surfaces inside partial_failure_error.
    currency_code:
      normalizeCurrency(ctx.currency_code) ?? normalizeCurrency(connection.currency_code) ?? 'USD',
    order_id: ctx.order_id,
    [ctx.identifier.type]: ctx.identifier.value,
  };
  try {
    const response = (await customer.conversionUploads.uploadClickConversions({
      customer_id: connection.customer_id,
      conversions: [cc],
      partial_failure: true,
      validate_only: false,
      debug_enabled: false,
    } as never)) as unknown as {
      partial_failure_error?: { message?: string } | null;
    };
    const partialMsg = typeof response?.partial_failure_error?.message === 'string' && response.partial_failure_error.message.trim() !== ''
      ? response.partial_failure_error.message
      : undefined;
    return { ok: true, partial: partialMsg, response };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function persistAttempt(args: {
  ctx: UploadContext;
  connection: GoogleAdsConnection;
  result: Awaited<ReturnType<typeof callGoogleAds>>;
}): Promise<void> {
  const { ctx, connection, result } = args;
  if (!result.ok) {
    await googleAdsUploadRepository.record({
      kind: ctx.kind,
      source_id: ctx.source_id,
      conversion_id: ctx.conversion_id,
      click_id: ctx.click_id,
      connection_id: connection.connection_id,
      customer_id: connection.customer_id,
      identifier_type: ctx.identifier.type,
      identifier_value: ctx.identifier.value,
      conversion_action_resource: ctx.conversion_action_resource,
      status: 'failed',
      attempts: 1,
      last_error: result.error.slice(0, 4000),
    });
    const isAuthError = /UNAUTHENTICATED|invalid_grant|PERMISSION_DENIED|UNAUTHORIZED/i.test(result.error);
    if (isAuthError) {
      await googleAdsConnectionRepository.update(connection.connection_id, {
        status: 'error',
        last_error: result.error.slice(0, 4000),
      });
    }
    // Auth-class failures are CRITICAL: the connection is now dead and every
    // future upload silently fails until the user re-authorizes. Generic upload
    // failures stay ERROR (transient, will retry on next conversion).
    logger[isAuthError ? 'critical' : 'error']('gads_upload_failed', {
      kind: ctx.kind, source_id: ctx.source_id,
      connection_id: connection.connection_id,
      auth_error: isAuthError,
      error: result.error,
    });
    return;
  }
  await googleAdsUploadRepository.record({
    kind: ctx.kind,
    source_id: ctx.source_id,
    conversion_id: ctx.conversion_id,
    click_id: ctx.click_id,
    connection_id: connection.connection_id,
    customer_id: connection.customer_id,
    identifier_type: ctx.identifier.type,
    identifier_value: ctx.identifier.value,
    conversion_action_resource: ctx.conversion_action_resource,
    status: result.partial ? 'partial_failure' : 'sent',
    attempts: 1,
    sent_at: new Date().toISOString(),
    last_error: result.partial,
    google_response: result.response as Record<string, unknown> | undefined,
  });
  if (result.partial) {
    logger.warn('gads_upload_partial_failure', {
      kind: ctx.kind, source_id: ctx.source_id,
      connection_id: connection.connection_id,
      error: result.partial,
    });
  } else {
    logger.info('gads_upload_sent', {
      kind: ctx.kind, source_id: ctx.source_id,
      connection_id: connection.connection_id,
      identifier_type: ctx.identifier.type,
    });
  }
}

async function recordSkip(args: {
  kind: GoogleAdsUploadKind;
  source_id: string;
  conversion_id?: string;
  click_id?: string;
  reason: string;
  connection_id?: string;
  customer_id?: string;
  identifier?: IdentifierPick;
  conversion_action_resource?: string;
}): Promise<void> {
  await googleAdsUploadRepository.record({
    kind: args.kind,
    source_id: args.source_id,
    conversion_id: args.conversion_id,
    click_id: args.click_id,
    connection_id: args.connection_id,
    customer_id: args.customer_id,
    identifier_type: args.identifier?.type,
    identifier_value: args.identifier?.value,
    conversion_action_resource: args.conversion_action_resource,
    status: 'skipped',
    attempts: 0,
    skip_reason: args.reason,
  });
  logger.info('gads_upload_skipped', {
    kind: args.kind,
    source_id: args.source_id,
    reason: args.reason,
  });
}

export const googleAdsForwardingService = {
  // ── conversions ───────────────────────────────────────────────────
  async dispatchConversion(input: DispatchConversionInput): Promise<void> {
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
    const identifier = pickIdentifier(click.ad_ids);
    if (!identifier) {
      await recordSkip({
        kind: 'conversion',
        source_id: conversion.conversion_id,
        conversion_id: conversion.conversion_id,
        reason: 'no_click_identifier',
      });
      return;
    }

    let dispatched = 0;

    // 1) Cross-account: fire to every active MCC connection that has a sale action set.
    const mccConns = await googleAdsConnectionRepository.listByType('mcc');
    for (const conn of mccConns) {
      if (conn.status !== 'active') continue;
      if (!conn.sale_conversion_action_resource) continue;
      const money = moneyForUpload(conversion, conn);
      const ctx: UploadContext = {
        kind: 'conversion',
        source_id: conversion.conversion_id,
        conversion_id: conversion.conversion_id,
        identifier,
        conversion_action_resource: conn.sale_conversion_action_resource,
        conversion_value: money.conversion_value,
        currency_code: money.currency_code,
        conversion_date_time_iso: adjustEventDateForGads(conversion, input.postback_timezone).toISOString(),
        raw_network_timestamp: conversion.network_timestamp,
        postback_timezone: input.postback_timezone,
        order_id: conversion.conversion_id,    // same order_id across MCCs is fine — different customer scope
      };
      const result = await callGoogleAds(conn, ctx);
      await persistAttempt({ ctx, connection: conn, result });
      dispatched++;
    }

    // 2) Per-offer/per-network child route. Status filter applies here.
    const route = await googleAdsRouteRepository.resolveForConversion(
      conversion.offer_id,
      conversion.network_id
    );
    if (route && route.sale_conversion_action_resource) {
      // No status filter — `verified === true` (already gated at the top of
      // dispatchConversion) is the real signal that the click_id matched a
      // tracked click. The network's `status` string is unreliable.
      const target = await googleAdsConnectionRepository.getById(route.target_connection_id);
      if (!target || target.status !== 'active') {
        await recordSkip({
          kind: 'conversion',
          source_id: conversion.conversion_id,
          conversion_id: conversion.conversion_id,
          reason: target ? 'connection_not_active' : 'destination_missing',
          identifier,
          connection_id: route.target_connection_id,
          conversion_action_resource: route.sale_conversion_action_resource,
        });
      } else {
        const money = moneyForUpload(conversion, target);
        const ctx: UploadContext = {
          kind: 'conversion',
          source_id: conversion.conversion_id,
          conversion_id: conversion.conversion_id,
          identifier,
          conversion_action_resource: route.sale_conversion_action_resource,
          conversion_value: money.conversion_value,
          currency_code: money.currency_code,
          conversion_date_time_iso: adjustEventDateForGads(conversion, input.postback_timezone).toISOString(),
          raw_network_timestamp: conversion.network_timestamp,
          postback_timezone: input.postback_timezone,
          order_id: conversion.conversion_id,
        };
        const result = await callGoogleAds(target, ctx);
        await persistAttempt({ ctx, connection: target, result });
        dispatched++;
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

  // ── outbound clicks ───────────────────────────────────────────────
  // Only fired when the click carried a Google ad-id. Non-Google clicks are
  // ignored entirely (no skipped doc, no log noise).
  async dispatchClick(input: DispatchClickInput): Promise<void> {
    const identifier = pickIdentifier(input.click.ad_ids);
    if (!identifier) return;

    const click = input.click;
    let dispatched = 0;

    // 1) Cross-account: every MCC with a click action set.
    const mccConns = await googleAdsConnectionRepository.listByType('mcc');
    for (const conn of mccConns) {
      if (conn.status !== 'active') continue;
      if (!conn.click_conversion_action_resource) continue;
      const ctx: UploadContext = {
        kind: 'click',
        source_id: click.click_id,
        click_id: click.click_id,
        identifier,
        conversion_action_resource: conn.click_conversion_action_resource,
        conversion_value: 0,
        currency_code: undefined,
        conversion_date_time_iso: click.created_at,
        order_id: `click_${click.click_id}`,
      };
      const result = await callGoogleAds(conn, ctx);
      await persistAttempt({ ctx, connection: conn, result });
      dispatched++;
    }

    // 2) Per-offer child route — only if it has a click action.
    const route = await googleAdsRouteRepository.resolveForOffer(click.offer_id);
    if (route && route.click_conversion_action_resource) {
      const target = await googleAdsConnectionRepository.getById(route.target_connection_id);
      if (target && target.status === 'active') {
        const ctx: UploadContext = {
          kind: 'click',
          source_id: click.click_id,
          click_id: click.click_id,
          identifier,
          conversion_action_resource: route.click_conversion_action_resource,
          conversion_value: 0,
          currency_code: undefined,
          conversion_date_time_iso: click.created_at,
          order_id: `click_${click.click_id}`,
        };
        const result = await callGoogleAds(target, ctx);
        await persistAttempt({ ctx, connection: target, result });
        dispatched++;
      }
    }

    if (dispatched === 0) {
      // Only log this as info — clicks with no destination configured are a
      // noisy condition while the user is still wiring things up.
      logger.info('gads_click_no_destination', { click_id: click.click_id });
    }
  },

  // ── batch conversions (affiliate API sync path) ─────────────────────
  // Groups all conversions by destination connection and sends ONE Google
  // Ads API call per connection instead of N individual calls. Returns
  // aggregate stats so the caller can surface them in the run record.
  async dispatchConversionsBatch(
    inputs: DispatchConversionInput[]
  ): Promise<{ sent: number; skipped: number; failed: number; errors: string[] }> {
    const stats = { sent: 0, skipped: 0, failed: 0, errors: [] as string[] };
    if (inputs.length === 0) return stats;

    // 1. Pre-filter: only verified conversions with a Google click identifier.
    type Eligible = {
      conversion: ConversionRecord;
      click: ClickRecord;
      identifier: IdentifierPick;
      postback_timezone?: string;
    };
    const eligible: Eligible[] = [];
    for (const { conversion, click, postback_timezone } of inputs) {
      if (!conversion.verified || !click) {
        stats.skipped++;
        continue;
      }
      const identifier = pickIdentifier(click.ad_ids);
      if (!identifier) {
        stats.skipped++;
        continue;
      }
      eligible.push({ conversion, click, identifier, postback_timezone });
    }
    if (eligible.length === 0) return stats;

    // 2. Fetch all active connections + routes ONCE for the entire batch.
    const mccConns = await googleAdsConnectionRepository.listByType('mcc');
    const activeMcc = mccConns.filter(
      (c) => c.status === 'active' && c.sale_conversion_action_resource
    );

    // Resolve per-offer/network routes — cache by offer_id+network_id so we
    // don't re-query for the same combo. Key = "offer_id|network_id".
    const routeCache = new Map<string, GoogleAdsRoute | null>();
    const connCache = new Map<string, GoogleAdsConnection | null>();

    async function resolveRoute(offer_id?: string, network_id?: string): Promise<{ route: GoogleAdsRoute; conn: GoogleAdsConnection } | null> {
      const key = `${offer_id ?? ''}|${network_id ?? ''}`;
      if (!routeCache.has(key)) {
        const route = await googleAdsRouteRepository.resolveForConversion(offer_id, network_id ?? '');
        routeCache.set(key, route);
      }
      const route = routeCache.get(key)!;
      if (!route || !route.sale_conversion_action_resource) return null;

      if (!connCache.has(route.target_connection_id)) {
        const conn = await googleAdsConnectionRepository.getById(route.target_connection_id);
        connCache.set(route.target_connection_id, conn && conn.status === 'active' ? conn : null);
      }
      const conn = connCache.get(route.target_connection_id)!;
      if (!conn) return null;
      return { route, conn };
    }

    // 3. Build per-connection conversion payloads.
    type ConnBatch = {
      connection: GoogleAdsConnection;
      payloads: Array<{ cc: Record<string, unknown>; eligible: Eligible; actionResource: string }>;
    };
    const batches = new Map<string, ConnBatch>();

    function ensureBatch(conn: GoogleAdsConnection): ConnBatch {
      let b = batches.get(conn.connection_id);
      if (!b) {
        b = { connection: conn, payloads: [] };
        batches.set(conn.connection_id, b);
      }
      return b;
    }

    for (const item of eligible) {
      const { conversion, identifier } = item;

      // MCC connections
      for (const conn of activeMcc) {
        const money = moneyForUpload(conversion, conn);
        const cc: Record<string, unknown> = {
          conversion_action: conn.sale_conversion_action_resource,
          conversion_date_time: formatGoogleAdsDateTime(
            adjustEventDateForGads(conversion, item.postback_timezone).toISOString(),
            conn.time_zone || 'UTC',
            conversion.network_timestamp,
            item.postback_timezone,
            conn.convert_tz_to_account
          ),
          conversion_value: money.conversion_value,
          currency_code: money.currency_code,
          order_id: conversion.conversion_id,
          [identifier.type]: identifier.value,
        };
        ensureBatch(conn).payloads.push({
          cc,
          eligible: item,
          actionResource: conn.sale_conversion_action_resource!,
        });
      }

      // Per-offer/network child route
      const resolved = await resolveRoute(conversion.offer_id, conversion.network_id);
      if (resolved) {
        const { route, conn } = resolved;
        const money = moneyForUpload(conversion, conn);
        const cc: Record<string, unknown> = {
          conversion_action: route.sale_conversion_action_resource,
          conversion_date_time: formatGoogleAdsDateTime(
            adjustEventDateForGads(conversion, item.postback_timezone).toISOString(),
            conn.time_zone || 'UTC',
            conversion.network_timestamp,
            item.postback_timezone,
            conn.convert_tz_to_account
          ),
          conversion_value: money.conversion_value,
          currency_code: money.currency_code,
          order_id: conversion.conversion_id,
          [identifier.type]: identifier.value,
        };
        ensureBatch(conn).payloads.push({
          cc,
          eligible: item,
          actionResource: route.sale_conversion_action_resource!,
        });
      }
    }

    // If no batches were built, every conversion was skipped (no destination).
    if (batches.size === 0) {
      stats.skipped += eligible.length;
      logger.info('gads_batch_no_destinations', { count: eligible.length });
      return stats;
    }

    // 4. Fire one API call per connection with all its conversions.
    for (const [, batch] of batches) {
      const { connection, payloads } = batch;
      const customer = buildCustomer({
        connection,
        customer_id: connection.customer_id,
        login_customer_id: connection.manager_customer_id,
      });

      try {
        const response = (await customer.conversionUploads.uploadClickConversions({
          customer_id: connection.customer_id,
          conversions: payloads.map((p) => p.cc),
          partial_failure: true,
          validate_only: false,
          debug_enabled: false,
        } as never)) as unknown as {
          partial_failure_error?: { message?: string } | null;
        };

        const partialMsg =
          typeof response?.partial_failure_error?.message === 'string' &&
          response.partial_failure_error.message.trim() !== ''
            ? response.partial_failure_error.message
            : undefined;

        if (partialMsg) {
          // Partial failure — some succeeded, some failed. We count the
          // whole batch as sent but log the partial error.
          stats.sent += payloads.length;
          stats.errors.push(
            `partial[${connection.connection_id}]: ${partialMsg.slice(0, 500)}`
          );
          logger.warn('gads_batch_partial_failure', {
            connection_id: connection.connection_id,
            count: payloads.length,
            error: partialMsg.slice(0, 500),
          });
        } else {
          stats.sent += payloads.length;
          logger.info('gads_batch_sent', {
            connection_id: connection.connection_id,
            count: payloads.length,
          });
        }

        // Persist audit docs in bulk (fire-and-forget to not block the run).
        for (const p of payloads) {
          googleAdsUploadRepository
            .record({
              kind: 'conversion',
              source_id: p.eligible.conversion.conversion_id,
              conversion_id: p.eligible.conversion.conversion_id,
              click_id: p.eligible.click.click_id,
              connection_id: connection.connection_id,
              customer_id: connection.customer_id,
              identifier_type: p.eligible.identifier.type,
              identifier_value: p.eligible.identifier.value,
              conversion_action_resource: p.actionResource,
              status: partialMsg ? 'partial_failure' : 'sent',
              attempts: 1,
              sent_at: new Date().toISOString(),
              last_error: partialMsg,
            })
            .catch(() => {});
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        stats.failed += payloads.length;
        stats.errors.push(
          `failed[${connection.connection_id}]: ${errMsg.slice(0, 500)}`
        );
        const isAuthError = /UNAUTHENTICATED|invalid_grant|PERMISSION_DENIED|UNAUTHORIZED/i.test(errMsg);
        // Auth-class batch failures are CRITICAL — see gads_upload_failed for
        // the same rationale: dead connection means silent data loss until
        // re-auth.
        logger[isAuthError ? 'critical' : 'error']('gads_batch_failed', {
          connection_id: connection.connection_id,
          count: payloads.length,
          auth_error: isAuthError,
          error: errMsg,
        });

        if (isAuthError) {
          await googleAdsConnectionRepository
            .update(connection.connection_id, {
              status: 'error',
              last_error: errMsg.slice(0, 4000),
            })
            .catch(() => {});
        }

        // Persist failed audit docs.
        for (const p of payloads) {
          googleAdsUploadRepository
            .record({
              kind: 'conversion',
              source_id: p.eligible.conversion.conversion_id,
              conversion_id: p.eligible.conversion.conversion_id,
              click_id: p.eligible.click.click_id,
              connection_id: connection.connection_id,
              customer_id: connection.customer_id,
              identifier_type: p.eligible.identifier.type,
              identifier_value: p.eligible.identifier.value,
              conversion_action_resource: p.actionResource,
              status: 'failed',
              attempts: 1,
              last_error: errMsg.slice(0, 4000),
            })
            .catch(() => {});
        }
      }
    }

    return stats;
  },

  // Background helpers — never let exceptions escape into the request path.
  forgetConversion(input: DispatchConversionInput): void {
    void this.dispatchConversion(input).catch((err) => {
      logger.error('gads_dispatch_conversion_uncaught', {
        conversion_id: input.conversion.conversion_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  },

  forgetClick(input: DispatchClickInput): void {
    void this.dispatchClick(input).catch((err) => {
      logger.error('gads_dispatch_click_uncaught', {
        click_id: input.click.click_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  },
};
