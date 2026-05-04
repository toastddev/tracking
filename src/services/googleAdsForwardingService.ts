import { buildCustomer } from './googleAdsClient';
import { eventDate } from './eventTime';
import {
  googleAdsConnectionRepository,
  googleAdsRouteRepository,
  googleAdsUploadRepository,
} from '../firestore';
import { logger } from '../utils/logger';
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
function formatGoogleAdsDateTime(iso: string, timeZone: string): string {
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
  // idempotency: same (kind, source_id, connection) repeated calls should
  // upload with the same order_id
  order_id: string;
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
    conversion_date_time: formatGoogleAdsDateTime(ctx.conversion_date_time_iso, connection.time_zone || 'UTC'),
    conversion_value: ctx.conversion_value,
    currency_code: ctx.currency_code || connection.currency_code || 'USD',
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
    if (/UNAUTHENTICATED|invalid_grant|PERMISSION_DENIED|UNAUTHORIZED/i.test(result.error)) {
      await googleAdsConnectionRepository.update(connection.connection_id, {
        status: 'error',
        last_error: result.error.slice(0, 4000),
      });
    }
    logger.error('gads_upload_failed', {
      kind: ctx.kind, source_id: ctx.source_id,
      connection_id: connection.connection_id,
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
      const ctx: UploadContext = {
        kind: 'conversion',
        source_id: conversion.conversion_id,
        conversion_id: conversion.conversion_id,
        identifier,
        conversion_action_resource: conn.sale_conversion_action_resource,
        conversion_value: conversion.payout ?? 0,
        currency_code: conversion.currency,
        conversion_date_time_iso: eventDate(conversion).toISOString(),
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
        const ctx: UploadContext = {
          kind: 'conversion',
          source_id: conversion.conversion_id,
          conversion_id: conversion.conversion_id,
          identifier,
          conversion_action_resource: route.sale_conversion_action_resource,
          conversion_value: conversion.payout ?? 0,
          currency_code: conversion.currency,
          conversion_date_time_iso: eventDate(conversion).toISOString(),
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
    };
    const eligible: Eligible[] = [];
    for (const { conversion, click } of inputs) {
      if (!conversion.verified || !click) {
        stats.skipped++;
        continue;
      }
      const identifier = pickIdentifier(click.ad_ids);
      if (!identifier) {
        stats.skipped++;
        continue;
      }
      eligible.push({ conversion, click, identifier });
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
        const cc: Record<string, unknown> = {
          conversion_action: conn.sale_conversion_action_resource,
          conversion_date_time: formatGoogleAdsDateTime(
            eventDate(conversion).toISOString(),
            conn.time_zone || 'UTC'
          ),
          conversion_value: conversion.payout ?? 0,
          currency_code: conversion.currency || conn.currency_code || 'USD',
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
        const cc: Record<string, unknown> = {
          conversion_action: route.sale_conversion_action_resource,
          conversion_date_time: formatGoogleAdsDateTime(
            eventDate(conversion).toISOString(),
            conn.time_zone || 'UTC'
          ),
          conversion_value: conversion.payout ?? 0,
          currency_code: conversion.currency || conn.currency_code || 'USD',
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
        logger.error('gads_batch_failed', {
          connection_id: connection.connection_id,
          count: payloads.length,
          error: errMsg,
        });

        // Check for auth errors and mark connection as errored.
        if (/UNAUTHENTICATED|invalid_grant|PERMISSION_DENIED|UNAUTHORIZED/i.test(errMsg)) {
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
