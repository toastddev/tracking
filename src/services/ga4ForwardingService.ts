import { ga4SettingsRepository, ga4StreamRepository, ga4UploadRepository } from '../firestore';
import type { Ga4UploadKind } from '../firestore';
import { adjustEventDateForGads } from './googleAdsForwardingService';
import { logger } from '../utils/logger';
import { decryptSecret } from '../utils/crypto';
import { normalizeCurrency, resolveUploadMoney } from '../utils/fxRates';
import type { ClickRecord, ConversionRecord } from '../types';

// Mirror of ./googleAdsForwardingService.ts for GA4, via the Measurement
// Protocol. Conversions and outbound clicks are uploaded under exactly the same
// rules as Google Ads so the two platforms always agree:
//
//                        Google Ads                       GA4
//   click identifier     gclid / gbraid / wbraid          ga_cid (+ ga_mid) the site
//                                                         appended to the tracker URL
//   destination          child route or every MCC         the GA4 stream linked for that
//                                                         ga_mid on the Connections tab
//                                                         (GA4_API_SECRETS as fallback)
//   what is sent         every verified conversion,       same - no status filtering, no
//                        no status filtering              transaction-id rules
//   dedupe key           order_id = conversion_id         transaction_id = conversion_id
//   conversion time      adjustEventDateForGads()         same function
//   value / currency     payout → GOOGLE_ADS_UPLOAD_      payout → GA4_UPLOAD_CURRENCY,
//                        CURRENCY, else account currency  else property currency
//   outbound clicks      click conversion action, when    click event name, when set
//                        set                              (value 0, like Google Ads)
//   audit                google_ads_uploads per attempt   ga4_uploads per attempt
//                        (sent / failed / skipped+reason) (sent / failed / skipped+reason)
//   batch (API sync)     dispatchConversionsBatch stats   same stats shape
//
// The only GA4-specific difference: GA4 accepts timestamp_micros at most 72h in
// the past. Older conversions are sent without a timestamp (GA4 records them at
// receipt time) instead of being dropped by GA4; session_id still ties them to
// the visitor's original session.
//
// Audit rows are written only while "Save upload audit data" is on (Connections
// tab → GA4, on by default). With it off, forwarding is unchanged and every
// outcome still reaches the structured logs - nothing is stored in Firestore.

export interface Ga4DispatchConversionInput {
  conversion: ConversionRecord;
  click: ClickRecord | null;
  /** IANA timezone of the network - same meaning as for Google Ads uploads. */
  postback_timezone?: string;
}
export interface Ga4DispatchClickInput {
  click: ClickRecord;
}

interface GaIdentifier {
  client_id: string;
  session_id?: string;
  measurement_id: string;
}

interface Destination {
  measurement_id: string;
  api_secret: string;
  connection_id?: string;
  currency_code?: string;
  sale_event_name: string;
  click_event_name?: string;
}

const CLIENT_ID_RE = /^\d{1,20}\.\d{1,20}$/;
const SESSION_ID_RE = /^\d{1,20}$/;
const MEASUREMENT_ID_RE = /^G-[A-Z0-9]{4,20}$/;

const MAX_BACKDATE_MS = 71 * 60 * 60 * 1000; // GA4 limit is 72h; margin for skew
const REQUEST_TIMEOUT_MS = 10_000;
const BATCH_CONCURRENCY = 5;

// ≈ pickIdentifier() in the Google Ads service.
function pickGaIdentifier(click: ClickRecord): GaIdentifier | null {
  const extra = click.extra_params ?? {};
  const client_id = (extra.ga_cid ?? '').trim();
  const measurement_id = (extra.ga_mid ?? '').trim().toUpperCase();
  if (!CLIENT_ID_RE.test(client_id) || !MEASUREMENT_ID_RE.test(measurement_id)) return null;
  const sid = (extra.ga_sid ?? '').trim();
  return { client_id, measurement_id, session_id: SESSION_ID_RE.test(sid) ? sid : undefined };
}

let envSecretsCache: Map<string, string> | null = null;
function envSecrets(): Map<string, string> {
  if (envSecretsCache) return envSecretsCache;
  const map = new Map<string, string>();
  for (const entry of (process.env.GA4_API_SECRETS ?? '').split(',')) {
    const idx = entry.indexOf(':');
    if (idx <= 0) continue;
    const mid = entry.slice(0, idx).trim().toUpperCase();
    const secret = entry.slice(idx + 1).trim();
    if (MEASUREMENT_ID_RE.test(mid) && secret) map.set(mid, secret);
  }
  envSecretsCache = map;
  return map;
}

function defaultSaleEventName(): string {
  return (process.env.GA4_CONVERSION_EVENT ?? '').trim() || 'purchase';
}

/**
 * ≈ route / connection resolution in the Google Ads service. Returns the
 * destination or the skip reason Google Ads would record.
 */
async function resolveDestination(
  measurement_id: string
): Promise<{ ok: true; dest: Destination } | { ok: false; reason: string; connection_id?: string }> {
  const stream = await ga4StreamRepository.get(measurement_id);
  if (stream) {
    if (!stream.enabled) return { ok: false, reason: 'connection_not_active', connection_id: stream.connection_id };
    try {
      return {
        ok: true,
        dest: {
          measurement_id,
          api_secret: decryptSecret(stream.api_secret_enc),
          connection_id: stream.connection_id,
          currency_code: stream.currency_code,
          sale_event_name: stream.sale_event_name || defaultSaleEventName(),
          click_event_name: stream.click_event_name || undefined,
        },
      };
    } catch {
      return { ok: false, reason: 'destination_secret_unreadable', connection_id: stream.connection_id };
    }
  }
  const envSecret = envSecrets().get(measurement_id);
  if (envSecret) {
    return {
      ok: true,
      dest: {
        measurement_id,
        api_secret: envSecret,
        sale_event_name: defaultSaleEventName(),
        click_event_name: (process.env.GA4_CLICK_EVENT ?? '').trim() || undefined,
      },
    };
  }
  return { ok: false, reason: 'no_destination_configured' };
}

// Throttled like the Google Ads fx warning - WARN routes to Telegram.
const fxWarnCache = new Set<string>();

/** GA4_UPLOAD_CURRENCY override, else the property's currency (≈ uploadCurrencyFor). */
function uploadCurrencyFor(dest: Destination): string {
  return (
    normalizeCurrency(process.env.GA4_UPLOAD_CURRENCY) ??
    normalizeCurrency(dest.currency_code) ??
    'USD'
  );
}

// ≈ moneyForUpload() in the Google Ads service.
function moneyForUpload(conversion: ConversionRecord, dest: Destination): { value: number; currency: string } {
  const target = uploadCurrencyFor(dest);
  const money = resolveUploadMoney(conversion.payout ?? 0, conversion.currency, target);
  if (money.ok) {
    if (money.converted) {
      logger.info('ga4_conversion_value_converted', {
        conversion_id: conversion.conversion_id,
        from_currency: conversion.currency,
        to_currency: money.currency,
        from_value: conversion.payout ?? 0,
        to_value: money.value,
        measurement_id: dest.measurement_id,
      });
    }
    return { value: money.value, currency: money.currency };
  }
  const key = `ga4_fx:${money.currency}->${target}`;
  if (!fxWarnCache.has(key)) {
    fxWarnCache.add(key);
    logger.warn('ga4_conversion_value_fx_missing', {
      from_currency: money.currency,
      to_currency: target,
      measurement_id: dest.measurement_id,
      effect: 'uploaded in source currency; GA4 will convert at its own daily rate',
      hint: `Add ${money.currency} to FX_RATES in src/utils/fxRates.constants.ts so the dashboard and GA4 agree.`,
    });
  }
  return { value: money.value, currency: money.currency };
}

function isDebug(): boolean {
  return process.env.GA4_MP_DEBUG === '1';
}

type MpResult = { ok: true; response?: Record<string, unknown> } | { ok: false; error: string };

// ≈ callGoogleAds(): one Measurement Protocol request.
async function callMeasurementProtocol(
  measurement_id: string,
  api_secret: string,
  body: Record<string, unknown>,
  debug = isDebug()
): Promise<MpResult> {
  const host = (process.env.GA4_MP_HOST ?? '').trim() || 'www.google-analytics.com';
  const url =
    `https://${host}${debug ? '/debug/mp/collect' : '/mp/collect'}` +
    `?measurement_id=${encodeURIComponent(measurement_id)}&api_secret=${encodeURIComponent(api_secret)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (debug) {
      const parsed = (await res.json().catch(() => ({}))) as {
        validationMessages?: Array<{ description?: string; fieldPath?: string }>;
      };
      const messages = parsed.validationMessages ?? [];
      if (messages.length > 0) {
        return {
          ok: false,
          error: `GA4 validation: ${messages.map((m) => `${m.fieldPath ?? ''} ${m.description ?? ''}`.trim()).join('; ')}`,
        };
      }
      return { ok: true, response: { debug_validation: 'passed' } };
    }
    // The production endpoint answers 2xx for anything it accepted and does not
    // validate payloads - a non-2xx means the request itself was refused.
    if (!res.ok) return { ok: false, error: `GA4 MP HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

interface UploadContext {
  kind: Ga4UploadKind;
  source_id: string;
  conversion_id?: string;
  click_id?: string;
  identifier: GaIdentifier;
  dest: Destination;
  event_name: string;
  transaction_id?: string;
  value?: number;
  currency?: string;
  event_time?: Date;
  params: Record<string, unknown>;
}

function buildBody(ctx: UploadContext): { body: Record<string, unknown>; backdated?: string } {
  const at = ctx.event_time?.getTime();
  const age = at === undefined ? NaN : Date.now() - at;
  const backdate = at !== undefined && Number.isFinite(age) && age >= 0 && age <= MAX_BACKDATE_MS;
  return {
    body: {
      client_id: ctx.identifier.client_id,
      ...(backdate ? { timestamp_micros: at! * 1000 } : {}),
      events: [
        {
          name: ctx.event_name,
          params: {
            // session_id makes GA4 attribute the event to the visitor's original
            // session (and so its source / medium / campaign).
            ...(ctx.identifier.session_id ? { session_id: Number(ctx.identifier.session_id) } : {}),
            engagement_time_msec: 1,
            ...ctx.params,
          },
        },
      ],
    },
    backdated: backdate ? new Date(at!).toISOString() : undefined,
  };
}

// ≈ persistAttempt(): call + audit row + log.
async function upload(ctx: UploadContext): Promise<'sent' | 'failed'> {
  const { body, backdated } = buildBody(ctx);
  const result = await callMeasurementProtocol(ctx.dest.measurement_id, ctx.dest.api_secret, body);
  const audit = await ga4SettingsRepository.auditEnabled();
  const base = {
    kind: ctx.kind,
    source_id: ctx.source_id,
    conversion_id: ctx.conversion_id,
    click_id: ctx.click_id,
    connection_id: ctx.dest.connection_id,
    measurement_id: ctx.dest.measurement_id,
    identifier_type: 'ga_client_id' as const,
    identifier_value: ctx.identifier.client_id,
    session_id: ctx.identifier.session_id,
    event_name: ctx.event_name,
    transaction_id: ctx.transaction_id,
    value: ctx.value,
    currency: ctx.currency,
    event_time: backdated,
    attempts: 1,
  };
  if (!result.ok) {
    if (audit) {
      await ga4UploadRepository
        .record({ ...base, status: 'failed', last_error: result.error.slice(0, 4000) })
        .catch(() => undefined);
    }
    logger.error('ga4_upload_failed', {
      kind: ctx.kind,
      source_id: ctx.source_id,
      measurement_id: ctx.dest.measurement_id,
      error: result.error,
    });
    return 'failed';
  }
  if (audit) {
    await ga4UploadRepository
      .record({ ...base, status: 'sent', sent_at: new Date().toISOString(), ga_response: result.response })
      .catch(() => undefined);
  }
  logger.info('ga4_upload_sent', {
    kind: ctx.kind,
    source_id: ctx.source_id,
    measurement_id: ctx.dest.measurement_id,
    session_joined: !!ctx.identifier.session_id,
    timestamp_sent: !!backdated,
  });
  return 'sent';
}

// ≈ recordSkip().
async function recordSkip(args: {
  kind: Ga4UploadKind;
  source_id: string;
  conversion_id?: string;
  click_id?: string;
  reason: string;
  connection_id?: string;
  identifier?: GaIdentifier;
}): Promise<void> {
  if (await ga4SettingsRepository.auditEnabled()) {
    await ga4UploadRepository.record({
      kind: args.kind,
      source_id: args.source_id,
      conversion_id: args.conversion_id,
      click_id: args.click_id,
      connection_id: args.connection_id,
      measurement_id: args.identifier?.measurement_id,
      identifier_type: args.identifier ? 'ga_client_id' : undefined,
      identifier_value: args.identifier?.client_id,
      session_id: args.identifier?.session_id,
      status: 'skipped',
      attempts: 0,
      skip_reason: args.reason,
    });
  }
  logger.info('ga4_upload_skipped', { kind: args.kind, source_id: args.source_id, reason: args.reason });
}

function conversionContext(
  input: Ga4DispatchConversionInput & { click: ClickRecord },
  identifier: GaIdentifier,
  dest: Destination
): UploadContext {
  const { conversion, click } = input;
  const money = moneyForUpload(conversion, dest);
  const item_id = conversion.offer_id || click.offer_id || 'unknown_offer';
  return {
    kind: 'conversion',
    source_id: conversion.conversion_id,
    conversion_id: conversion.conversion_id,
    click_id: click.click_id,
    identifier,
    dest,
    event_name: dest.sale_event_name,
    transaction_id: conversion.conversion_id, // ≈ order_id
    value: money.value,
    currency: money.currency,
    event_time: adjustEventDateForGads(conversion, input.postback_timezone),
    params: {
      transaction_id: conversion.conversion_id,
      value: money.value,
      currency: money.currency,
      affiliation: conversion.network_id,
      offer_id: item_id,
      network_id: conversion.network_id,
      conversion_source: conversion.source ?? 'postback',
      items: [{ item_id, item_name: item_id, affiliation: conversion.network_id, price: money.value, quantity: 1 }],
    },
  };
}

export const ga4ForwardingService = {
  // ── conversions ───────────────────────────────────────────────────
  async dispatchConversion(input: Ga4DispatchConversionInput): Promise<void> {
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
    const identifier = pickGaIdentifier(click);
    if (!identifier) {
      await recordSkip({
        kind: 'conversion',
        source_id: conversion.conversion_id,
        conversion_id: conversion.conversion_id,
        click_id: click.click_id,
        reason: 'no_click_identifier',
      });
      return;
    }
    const resolved = await resolveDestination(identifier.measurement_id);
    if (!resolved.ok) {
      await recordSkip({
        kind: 'conversion',
        source_id: conversion.conversion_id,
        conversion_id: conversion.conversion_id,
        click_id: click.click_id,
        reason: resolved.reason,
        connection_id: resolved.connection_id,
        identifier,
      });
      return;
    }
    await upload(conversionContext({ ...input, click }, identifier, resolved.dest));
  },

  // ── outbound clicks ───────────────────────────────────────────────
  // Only fired when the click carried GA ids, and only uploaded when the
  // stream has a click event name set - same as Google Ads with no click
  // conversion action. No skipped doc, no log noise otherwise.
  async dispatchClick(input: Ga4DispatchClickInput): Promise<void> {
    const click = input.click;
    const identifier = pickGaIdentifier(click);
    if (!identifier) return;
    const resolved = await resolveDestination(identifier.measurement_id);
    if (!resolved.ok || !resolved.dest.click_event_name) {
      logger.info('ga4_click_no_destination', { click_id: click.click_id });
      return;
    }
    await upload({
      kind: 'click',
      source_id: click.click_id,
      click_id: click.click_id,
      identifier,
      dest: resolved.dest,
      event_name: resolved.dest.click_event_name,
      value: 0,
      event_time: new Date(click.created_at),
      params: { offer_id: click.offer_id, aff_id: click.aff_id, click_id: click.click_id },
    });
  },

  // ── batch conversions (affiliate API sync path) ─────────────────────
  // Same contract and stats as googleAdsForwardingService.dispatchConversionsBatch:
  // ineligible rows count as skipped without an audit doc. The Measurement
  // Protocol can't carry several users in one request, so eligible rows are
  // sent individually with bounded concurrency.
  async dispatchConversionsBatch(
    inputs: Ga4DispatchConversionInput[]
  ): Promise<{ sent: number; skipped: number; failed: number; errors: string[] }> {
    const stats = { sent: 0, skipped: 0, failed: 0, errors: [] as string[] };
    const ready: UploadContext[] = [];
    const destCache = new Map<string, Awaited<ReturnType<typeof resolveDestination>>>();

    for (const input of inputs) {
      const { conversion, click } = input;
      if (!conversion.verified || !click) { stats.skipped++; continue; }
      const identifier = pickGaIdentifier(click);
      if (!identifier) { stats.skipped++; continue; }
      if (!destCache.has(identifier.measurement_id)) {
        destCache.set(identifier.measurement_id, await resolveDestination(identifier.measurement_id));
      }
      const resolved = destCache.get(identifier.measurement_id)!;
      if (!resolved.ok) { stats.skipped++; continue; }
      ready.push(conversionContext({ ...input, click }, identifier, resolved.dest));
    }
    if (ready.length === 0) return stats;

    for (let i = 0; i < ready.length; i += BATCH_CONCURRENCY) {
      const outcomes = await Promise.allSettled(ready.slice(i, i + BATCH_CONCURRENCY).map((ctx) => upload(ctx)));
      outcomes.forEach((o, j) => {
        if (o.status === 'fulfilled' && o.value === 'sent') {
          stats.sent++;
        } else {
          stats.failed++;
          const ctx = ready[i + j]!;
          stats.errors.push(
            `failed[${ctx.dest.measurement_id}] ${ctx.source_id}: ${o.status === 'rejected' ? String(o.reason) : 'see ga4_uploads'}`.slice(0, 500)
          );
        }
      });
    }
    logger.info('ga4_batch_sent', { count: ready.length, sent: stats.sent, failed: stats.failed });
    return stats;
  },

  // Background helpers - never let exceptions escape into the request path.
  forgetConversion(input: Ga4DispatchConversionInput): void {
    void this.dispatchConversion(input).catch((err) => {
      logger.error('ga4_dispatch_conversion_uncaught', {
        conversion_id: input.conversion.conversion_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  },

  forgetClick(input: Ga4DispatchClickInput): void {
    void this.dispatchClick(input).catch((err) => {
      logger.error('ga4_dispatch_click_uncaught', {
        click_id: input.click.click_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  },

  /**
   * Connections-tab "Validate" button: checks a sample purchase against GA4's
   * debug endpoint with the stream's secret. Nothing is recorded in GA4.
   */
  async validateStream(measurement_id: string): Promise<{ ok: boolean; messages: string[] }> {
    const resolved = await resolveDestination(measurement_id);
    if (!resolved.ok) return { ok: false, messages: [resolved.reason] };
    const result = await callMeasurementProtocol(
      measurement_id,
      resolved.dest.api_secret,
      {
        client_id: '1234567890.1234567890',
        events: [
          {
            name: resolved.dest.sale_event_name,
            params: {
              session_id: Math.floor(Date.now() / 1000),
              engagement_time_msec: 1,
              transaction_id: 'validation-only',
              value: 1,
              currency: uploadCurrencyFor(resolved.dest),
              items: [{ item_id: 'validation', item_name: 'validation', price: 1, quantity: 1 }],
            },
          },
        ],
      },
      true
    );
    return result.ok ? { ok: true, messages: [] } : { ok: false, messages: [result.error] };
  },
};
